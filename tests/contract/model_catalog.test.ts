import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { Agent } from "undici";
import { describe, expect, it, vi } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import {
  CopilotModelCatalog,
  parseCapiModels,
} from "../../src/copilot/model_catalog.js";
import { productionModelInfoLookup } from "../../src/copilot/model_metadata.js";
import { registrySnapshotFromDiscovery, testModelCapabilityRegistry } from "./model_capability_registry_harness.js";
import { CapiFetchError, HttpCopilotModelsSource } from "../../src/copilot/models_source.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { createModelCatalogRoutes } from "../../src/protocols/model_catalog/routes.js";
import { resolveModel } from "../../src/protocols/model_catalog/resolver.js";
import { serializeAnthropicModels, serializeOpenAiModels } from "../../src/protocols/model_catalog/wire.js";

const nowMs = (): number => 1_700_000_000_000;

const CAPI = {
  data: [
    { id: "keep", name: "Keep", vendor: "x", model_picker_enabled: true },
    { id: "hidden", name: "Hidden", vendor: "x", model_picker_enabled: false },
    { id: "keep", name: "Dup", vendor: "x", model_picker_enabled: true },
  ],
};

describe("CAPI parse and cache", () => {
  it("provides pinned production getModelInfo metadata without guessing unknown models", () => {
    expect(productionModelInfoLookup.get("gpt-5.1-codex-max")).toEqual({
      mode: "responses",
      max_input_tokens: 128_000,
      max_output_tokens: 128_000,
      supported_endpoints: ["/v1/responses"],
    });
    expect(productionModelInfoLookup.get("claude-opus-4.6-fast")).toEqual({
      mode: "chat",
      max_input_tokens: 128_000,
      max_output_tokens: 16_000,
      supported_endpoints: ["/v1/chat/completions"],
      chat_output_token_field: "max_tokens",
    });
    expect(productionModelInfoLookup.get("gemini-3-pro-preview")).toEqual({
      mode: "chat",
      max_input_tokens: 128_000,
      max_output_tokens: 64_000,
      chat_output_token_field: "max_tokens",
    });
    expect(productionModelInfoLookup.get("gpt-4o")).toEqual({
      mode: "chat",
      max_input_tokens: 64_000,
      max_output_tokens: 4_096,
      chat_output_token_field: "max_tokens",
    });
    expect(productionModelInfoLookup.get("gpt-5.3-codex")).toEqual({
      mode: "responses",
      max_input_tokens: 128_000,
      max_output_tokens: 128_000,
      supported_endpoints: ["/v1/responses"],
    });
    expect(productionModelInfoLookup.get("mai-code-1-flash")).toEqual({
      mode: "chat",
      max_input_tokens: 128_000,
      max_output_tokens: 64_000,
      supported_endpoints: ["/v1/chat/completions"],
      chat_output_token_field: "max_tokens",
    });
    expect(productionModelInfoLookup.get("mai-code-1-flash-internal")).toEqual(
      productionModelInfoLookup.get("mai-code-1-flash"),
    );
    expect(productionModelInfoLookup.get("unknown-model")).toBeNull();
  });

  it("keeps picker-enabled models in upstream order including duplicates", () => {
    const models = parseCapiModels(CAPI);
    expect(models.map((model) => model.id)).toEqual(["keep", "keep"]);
    expect(models[0]?.capabilities.protocols.state).toBe("missing");
  });

  it("rejects incomplete CAPI items", () => {
    expect(() => parseCapiModels({ data: [{ id: "x" }] })).toThrow(/invalid/u);
  });

  it.each([
    { name: "prompt and larger context window", fields: { capabilities: { limits: { max_prompt_tokens: 128_000, max_context_window_tokens: 144_000 } } }, expected: { state: "value", value: 128_000 } },
    { name: "top-level input and context window", fields: { max_input_tokens: 128_000, capabilities: { limits: { max_context_window_tokens: 144_000 } } }, expected: { state: "value", value: 128_000 } },
    { name: "model-info input and context window", fields: { model_info: { max_input_tokens: "128000" }, capabilities: { limits: { max_context_window_tokens: 144_000 } } }, expected: { state: "value", value: 128_000 } },
    { name: "capabilities input and context window", fields: { capabilities: { max_input_tokens: 128_000, limits: { max_context_window_tokens: 144_000 } } }, expected: { state: "value", value: 128_000 } },
    { name: "equal true aliases and different context window", fields: { max_input_tokens: 128_000, model_info: { max_input_tokens: "128000" }, capabilities: { max_input_tokens: 128_000, limits: { max_prompt_tokens: "128000", max_context_window_tokens: 144_000 } } }, expected: { state: "value", value: 128_000 } },
    { name: "prompt only", fields: { capabilities: { limits: { max_prompt_tokens: 128_000 } } }, expected: { state: "value", value: 128_000 } },
    { name: "context only", fields: { capabilities: { limits: { max_context_window_tokens: "144000" } } }, expected: { state: "value", value: 144_000 } },
    { name: "malformed prompt and valid context", fields: { capabilities: { limits: { max_prompt_tokens: null, max_context_window_tokens: 144_000 } } }, expected: { state: "malformed" } },
    { name: "no declarations", fields: {}, expected: { state: "missing" } },
    { name: "empty containers", fields: { model_info: {}, capabilities: { limits: {} } }, expected: { state: "missing" } },
  ])("parses input limits separately from context fallback: $name", ({ fields, expected }) => {
    const [model] = parseCapiModels({ data: [{
      id: "limits", name: "Limits", vendor: "test", model_picker_enabled: true, ...fields,
    }] });
    expect(model?.capabilities.maxInputTokens).toEqual(expected);
  });

  it.each([
    { name: "top-level input", fields: (input: unknown) => ({ max_input_tokens: input, capabilities: { limits: { max_prompt_tokens: 128_000, max_context_window_tokens: 144_000 } } }) },
    { name: "model-info input", fields: (input: unknown) => ({ model_info: { max_input_tokens: input }, capabilities: { limits: { max_prompt_tokens: 128_000, max_context_window_tokens: 144_000 } } }) },
    { name: "capabilities input", fields: (input: unknown) => ({ capabilities: { max_input_tokens: input, limits: { max_prompt_tokens: 128_000, max_context_window_tokens: 144_000 } } }) },
    { name: "prompt", fields: (input: unknown) => ({ max_input_tokens: 128_000, capabilities: { limits: { max_prompt_tokens: input, max_context_window_tokens: 144_000 } } }) },
  ])("keeps conflicting or malformed true input aliases fail-closed: $name", ({ fields }) => {
    for (const input of [64_000, undefined, null, false, 0, -1, 1.5, "", "0", "128000x", " 128000 ", Number.MAX_SAFE_INTEGER + 1, [], {}]) {
      const [model] = parseCapiModels({ data: [{
        id: "limits", name: "Limits", vendor: "test", model_picker_enabled: true, ...fields(input),
      }] });
      expect(model?.capabilities.maxInputTokens, `input: ${String(input)}`).toEqual({ state: "malformed" });
    }
  });

  it("ignores malformed context values only when explicit input is valid", () => {
    for (const context of [undefined, null, false, 0, -1, 1.5, "", "144000x", Number.MAX_SAFE_INTEGER + 1, [], {}]) {
      for (const explicit of [{}, { max_prompt_tokens: 128_000 }, { max_prompt_tokens: null }]) {
        const [model] = parseCapiModels({ data: [{
          id: "limits", name: "Limits", vendor: "test", model_picker_enabled: true,
          capabilities: { limits: { ...explicit, max_context_window_tokens: context } },
        }] });
        expect(model?.capabilities.maxInputTokens).toEqual(explicit.max_prompt_tokens === 128_000
          ? { state: "value", value: 128_000 }
          : { state: "malformed" });
      }
    }
  });

  it.each([
    { name: "model-info", fields: (container: unknown) => ({ model_info: container, capabilities: { limits: { max_context_window_tokens: 144_000 } } }) },
    { name: "capabilities", fields: (container: unknown) => ({ capabilities: container }) },
    { name: "limits", fields: (container: unknown) => ({ capabilities: { limits: container } }) },
  ])("keeps invalid input containers fail-closed even with valid input: $name", ({ fields }) => {
    for (const container of [undefined, null, false, 128_000, "128000", []]) {
      for (const explicit of [{}, { max_input_tokens: 128_000 }]) {
        const [model] = parseCapiModels({ data: [{
          id: "limits", name: "Limits", vendor: "test", model_picker_enabled: true,
          ...explicit, ...fields(container),
        }] });
        expect(model?.capabilities.maxInputTokens).toEqual({ state: "malformed" });
      }
    }
  });

  it("preserves explicit live capability fields without a global metadata map", async () => {
    const source = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: "https://api.githubcopilot.com" }),
      async () => new Response(JSON.stringify({ data: [{
        id: "native",
        name: "Native",
        vendor: "openai",
        model_picker_enabled: true,
        capabilities: {
          supported_endpoints: ["/responses", "/v1/chat/completions"],
          limits: {
            max_prompt_tokens: "128000",
            max_context_window_tokens: 144_000,
            max_output_tokens: 64_000,
          },
          chat_output_token_field: "max_completion_tokens",
        },
      }] })),
      { connectTimeoutMs: 20, totalTimeoutMs: 100, bodyLimitBytes: 1_024 },
      () => new Agent(),
    );
    const catalog = new CopilotModelCatalog(source);
    const snapshot = await catalog.get("github.com/1", new AbortController().signal);
    expect(snapshot.models[0]?.capabilities).toMatchObject({
      protocols: { state: "value", value: ["chat", "responses"] },
      maxInputTokens: { state: "value", value: 128_000 },
      maxOutputTokens: { state: "value", value: 64_000 },
      chatOutputTokenField: { state: "value", value: "max_completion_tokens" },
    });
    const effective = await registrySnapshotFromDiscovery(bound("github.com/1"), snapshot);
    expect(JSON.parse(serializeOpenAiModels(effective)).data[0]).toEqual({
      id: "native", object: "model", created: 1_677_610_602, owned_by: "openai",
      max_input_tokens: 128_000,
      max_output_tokens: 64_000,
    });
    expect(JSON.parse(serializeAnthropicModels(effective)).data[0]).toEqual({
      type: "model", id: "native", display_name: "native", created_at: "2023-02-28T18:56:42Z",
      max_input_tokens: 128_000,
      max_tokens: 64_000,
    });
    expect(effective.models[0]?.defaultOutputTokens).toMatchObject({
      effective: 8192, source: "known_ceiling", valid: true,
    });
    await catalog.close();
  });

  it("does not write cache after invalidate generation change", async () => {
    let fetches = 0;
    const catalog = new CopilotModelCatalog({
      async fetch() {
        fetches += 1;
        return CAPI;
      },
    }, () => new Date("2026-08-30T05:00:00.000Z"));
    const first = catalog.get("github.com/1", new AbortController().signal);
    catalog.invalidate("github.com/1");
    const snapshot = await first;
    expect(snapshot.models[0]?.id).toBe("keep");
    await catalog.get("github.com/1", new AbortController().signal);
    expect(fetches).toBe(2);
  });

  it("cancels displaced catalog fetches after their last waiter aborts", async () => {
    let fetches = 0;
    let aborts = 0;
    const catalog = new CopilotModelCatalog({
      async fetch(_accountId, signal) {
        fetches += 1;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborts += 1;
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
        return { data: [] };
      },
    });
    for (let index = 0; index < 20; index += 1) {
      const controller = new AbortController();
      const pending = catalog.get("github.com/1", controller.signal);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      catalog.invalidate("github.com/1");
    }
    await vi.waitFor(() => expect(aborts).toBe(20));
    expect(fetches).toBe(20);
    await catalog.close();
  });

  it("does not let an aborted orphan poison the next catalog request", async () => {
    let fetches = 0;
    const catalog = new CopilotModelCatalog({
      async fetch(_accountId, signal) {
        fetches += 1;
        if (fetches > 1) {
          return { data: [] };
        }
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            setTimeout(() => reject(new DOMException("aborted", "AbortError")), 20);
          }, { once: true });
        });
        return { data: [] };
      },
    });
    const controller = new AbortController();
    const first = catalog.get("github.com/1", controller.signal);
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(catalog.get("github.com/1", new AbortController().signal)).resolves.toMatchObject({
      models: [],
    });
    expect(fetches).toBe(2);
    await catalog.close();
  });

  it("does not let an older credential generation replace a newer cache entry", async () => {
    const releases = new Map<number, () => void>();
    let fetches = 0;
    const catalog = new CopilotModelCatalog({
      async fetch(_accountId, _signal, credentialGeneration = 0) {
        fetches += 1;
        await new Promise<void>((resolve) => releases.set(credentialGeneration, resolve));
        return {
          data: [{
            id: `generation-${credentialGeneration}`,
            name: "Generation",
            vendor: "test",
            model_picker_enabled: true,
          }],
        };
      },
    });
    const older = catalog.get("github.com/1", new AbortController().signal, 1);
    const newer = catalog.get("github.com/1", new AbortController().signal, 2);
    releases.get(2)?.();
    await expect(newer).resolves.toMatchObject({ credentialGeneration: 2 });
    releases.get(1)?.();
    await expect(older).resolves.toMatchObject({ credentialGeneration: 1 });
    const cached = await catalog.get("github.com/1", new AbortController().signal, 2);
    expect(cached.models[0]?.id).toBe("generation-2");
    expect(fetches).toBe(2);
  });

  it("aborts every displaced in-flight generation during close", async () => {
    let aborts = 0;
    const catalog = new CopilotModelCatalog({
      async fetch(_accountId, signal) {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborts += 1;
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
        return { data: [] };
      },
    });
    const older = catalog.get("github.com/1", new AbortController().signal, 1);
    const newer = catalog.get("github.com/1", new AbortController().signal, 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await catalog.close();
    await expect(older).rejects.toMatchObject({ name: "AbortError" });
    await expect(newer).rejects.toMatchObject({ name: "AbortError" });
    expect(aborts).toBe(2);
  });

  it("caches empty catalogs per account and does not share them", async () => {
    const seen: string[] = [];
    const catalog = new CopilotModelCatalog({
      async fetch(accountId) {
        seen.push(accountId);
        return { data: [] };
      },
    });
    const a = await catalog.get("github.com/1", new AbortController().signal);
    const b = await catalog.get("github.com/1", new AbortController().signal);
    const c = await catalog.get("github.com/2", new AbortController().signal);
    expect(a.models).toEqual([]);
    expect(b.models).toEqual([]);
    expect(c.accountId).toBe("github.com/2");
    expect(seen).toEqual(["github.com/1", "github.com/2"]);
  });

  it("maps CAPI redirects, Retry-After, body limits, and timeouts safely", async () => {
    const source = (fetchImpl: typeof fetch) => new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: "https://api.githubcopilot.com" }),
      fetchImpl,
      { connectTimeoutMs: 1, totalTimeoutMs: 20, bodyLimitBytes: 32 },
    );

    await expect(source(async () => new Response(null, { status: 302 })).fetch("github.com/1", new AbortController().signal))
      .rejects.toMatchObject({ status: 502 });

    for (const headers of [
      new Headers({ "retry-after": "120, 240" }),
      duplicateRetryAfterHeaders(),
      new Headers({ "retry-after": "Foo, 06 Nov 1994 08:49:37 GMT" }),
    ]) {
      await expect(source(async () => new Response("{}", { status: 429, headers })).fetch("github.com/1", new AbortController().signal))
        .rejects.toMatchObject({ status: 429, retryAfter: undefined });
    }

    await expect(source(async () => new Response("{}", {
      status: 429,
      headers: { "retry-after": "Sun, 06 Nov 1994 08:49:37 GMT" },
    })).fetch("github.com/1", new AbortController().signal))
      .rejects.toMatchObject({ status: 429, retryAfter: "Sun, 06 Nov 1994 08:49:37 GMT" });

    await expect(source(async () => new Response(`{"data":"${"x".repeat(40)}"}`)).fetch("github.com/1", new AbortController().signal))
      .rejects.toBeInstanceOf(CapiFetchError);

    await expect(source(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response("{\"data\":[]}");
    }).fetch("github.com/1", new AbortController().signal)).rejects.toMatchObject({ status: 502 });
  });

  function duplicateRetryAfterHeaders(): Headers {
    const headers = new Headers();
    headers.append("retry-after", "120");
    headers.append("retry-after", "240");
    return headers;
  }

  it("cleans up CAPI bodies on invalid redirects, body timeout, and caller abort", async () => {
    let redirectCanceled = false;
    const redirectSource = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: "https://api.githubcopilot.com" }),
      async () => new Response(new ReadableStream<Uint8Array>({
        cancel(): void {
          redirectCanceled = true;
        },
      }), { status: 302, headers: { location: "http://[invalid" } }),
      { connectTimeoutMs: 20, totalTimeoutMs: 20, bodyLimitBytes: 32 },
    );
    await expect(redirectSource.fetch("github.com/1", new AbortController().signal)).rejects.toMatchObject({ status: 502 });
    expect(redirectCanceled).toBe(true);

    let timeoutCanceled = false;
    const timeoutSource = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: "https://api.githubcopilot.com" }),
      async () => new Response(new ReadableStream<Uint8Array>({
        cancel(): void {
          timeoutCanceled = true;
        },
      }), { status: 200 }),
      { connectTimeoutMs: 20, totalTimeoutMs: 1, bodyLimitBytes: 32 },
    );
    await expect(timeoutSource.fetch("github.com/1", new AbortController().signal)).rejects.toMatchObject({ status: 502 });
    for (let index = 0; index < 20 && !timeoutCanceled; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(timeoutCanceled).toBe(true);

    let abortCanceled = false;
    const abortController = new AbortController();
    const abortSource = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: "https://api.githubcopilot.com" }),
      async () => new Response(new ReadableStream<Uint8Array>({
        cancel(): void {
          abortCanceled = true;
        },
      }), { status: 200 }),
      { connectTimeoutMs: 20, totalTimeoutMs: 20, bodyLimitBytes: 32 },
    );
    const pending = abortSource.fetch("github.com/1", abortController.signal);
    abortController.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    for (let index = 0; index < 20 && !abortCanceled; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(abortCanceled).toBe(true);
  });

  it("uses the default Undici request path without automatic decompression", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/models") {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-encoding": "gzip",
        });
        response.end(gzipSync("{\"data\":[]}"));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP server address");
    }
    try {
      const source = new HttpCopilotModelsSource(
        async () => ({ token: "token", endpoint: `http://127.0.0.1:${address.port}` }),
      );
      await expect(source.fetch("github.com/1", new AbortController().signal)).rejects.toMatchObject({ status: 502 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reuses a bounded CAPI dispatcher and closes it on gateway shutdown", async () => {
    const sockets = new Set<Socket>();
    let createdDispatchers = 0;
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      expect(request.url).toBe("/models");
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"data\":[]}");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP server address");
    }
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cat-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
    await accounts.upsertAuthenticated({
      host: "github.com",
      userId: "1",
      secret: { generation: 0, githubToken: "t" },
    });
    const source = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: `http://127.0.0.1:${address.port}` }),
      fetch,
      { connectTimeoutMs: 100, totalTimeoutMs: 1_000, bodyLimitBytes: 32 },
      (limits) => {
        createdDispatchers += 1;
        return new Agent({
          connectTimeout: limits.connectTimeoutMs,
          connections: 1,
          pipelining: 1,
        });
      },
    );
    const catalog = new CopilotModelCatalog(source);
    const registry = testModelCapabilityRegistry(catalog);
    const gw = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: dir }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, createModelCatalogRoutes({
      directory: accounts,
      registry,
      preferences: accounts.preferences,
    }), { onClose: () => registry.close() });
    try {
      expect((await gw.fetch(new Request("http://127.0.0.1:31400/v1/models"))).status).toBe(200);
      registry.invalidate("github.com/1");
      expect((await gw.fetch(new Request("http://127.0.0.1:31400/v1/models"))).status).toBe(200);
      expect(requests).toBe(2);
      expect(createdDispatchers).toBe(1);
      expect(sockets.size).toBeLessThanOrEqual(1);

      await gw.close();
      for (let index = 0; index < 20 && sockets.size > 0; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(sockets.size).toBe(0);
      await expect(catalog.get("github.com/1", new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
      await expect(source.fetch("github.com/1", new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await gw.close();
      closeDatabase(database);
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("strips sensitive CAPI headers on cross-host redirects", async () => {
    let calls = 0;
    let redirectedHeaders: Headers | undefined;
    const source = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: "https://api.githubcopilot.com" }),
      async (_input, init) => {
        calls += 1;
        if (calls === 1) {
          return new Response(null, {
            status: 302,
            headers: { location: "https://copilot.example.com/models" },
          });
        }
        redirectedHeaders = new Headers(init?.headers);
        return new Response("{\"data\":[]}", { status: 200 });
      },
      { connectTimeoutMs: 20, totalTimeoutMs: 100, bodyLimitBytes: 32 },
    );
    await source.fetch("github.com/1", new AbortController().signal);
    expect(calls).toBe(2);
    expect(redirectedHeaders?.has("authorization")).toBe(false);
    expect(redirectedHeaders?.has("cookie")).toBe(false);
    expect(redirectedHeaders?.has("cookie2")).toBe(false);
    expect(redirectedHeaders?.has("proxy-authorization")).toBe(false);
    expect(redirectedHeaders?.has("www-authenticate")).toBe(false);
  });

  it("enforces timeout on the default Undici request path", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{\"data\":[]}");
      }, 20);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP server address");
    }
    try {
      const source = new HttpCopilotModelsSource(
        async () => ({ token: "token", endpoint: `http://127.0.0.1:${address.port}` }),
        fetch,
        { connectTimeoutMs: 100, totalTimeoutMs: 1, bodyLimitBytes: 32 },
      );
      await expect(source.fetch("github.com/1", new AbortController().signal)).rejects.toMatchObject({ status: 502 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("recovers after one shared dispatcher factory rejection without poisoning later fetches", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"data\":[]}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP server address");
    }
    let factoryCalls = 0;
    const source = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: `http://127.0.0.1:${address.port}` }),
      fetch,
      { connectTimeoutMs: 100, totalTimeoutMs: 1_000, bodyLimitBytes: 32 },
      () => {
        factoryCalls += 1;
        if (factoryCalls === 1) {
          throw new Error("factory failed");
        }
        return new Agent({ connections: 1, pipelining: 1 });
      },
    );
    try {
      const first = source.fetch("github.com/1", new AbortController().signal);
      const concurrent = source.fetch("github.com/2", new AbortController().signal);
      await expect(first).rejects.toThrow("factory failed");
      await expect(concurrent).rejects.toThrow("factory failed");
      expect(factoryCalls).toBe(1);
      await expect(source.fetch("github.com/1", new AbortController().signal)).resolves.toEqual({ data: [] });
      expect(factoryCalls).toBe(2);
    } finally {
      await source.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps a newer dispatcher generation when an older shared waiter settles later", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"data\":[]}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP server address");
    }
    let rejectFirst: (error: Error) => void = () => undefined;
    const firstFactory = new Promise<Agent>((_resolve, reject) => {
      rejectFirst = reject;
    });
    let resolveSecond: (dispatcher: Agent) => void = () => undefined;
    const secondFactory = new Promise<Agent>((resolve) => {
      resolveSecond = resolve;
    });
    let factoryCalls = 0;
    const source = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: `http://127.0.0.1:${address.port}` }),
      fetch,
      { connectTimeoutMs: 100, totalTimeoutMs: 1_000, bodyLimitBytes: 32 },
      async () => {
        factoryCalls += 1;
        return await (factoryCalls === 1 ? firstFactory : secondFactory);
      },
    );
    try {
      const olderFirst = source.fetch("github.com/1", new AbortController().signal);
      const olderSecond = source.fetch("github.com/2", new AbortController().signal);
      const newer = olderFirst.catch(async () => await source.fetch("github.com/3", new AbortController().signal));
      rejectFirst(new Error("first generation failed"));
      await expect(olderSecond).rejects.toThrow("first generation failed");
      await vi.waitFor(() => expect(factoryCalls).toBe(2));
      const newerCompanion = source.fetch("github.com/4", new AbortController().signal);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(factoryCalls).toBe(2);
      resolveSecond(new Agent({ connections: 1, pipelining: 1 }));
      await expect(Promise.all([newer, newerCompanion])).resolves.toEqual([{ data: [] }, { data: [] }]);
      expect(factoryCalls).toBe(2);
    } finally {
      await source.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("bounds and cancels waits for a pending model dispatcher factory", async () => {
    let resolveFactory: (dispatcher: Agent) => void = () => undefined;
    const factory = new Promise<Agent>((resolve) => {
      resolveFactory = resolve;
    });
    const dispatcher = new Agent();
    const destroy = vi.spyOn(dispatcher, "destroy");
    const source = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: "http://127.0.0.1:1" }),
      fetch,
      { connectTimeoutMs: 20, totalTimeoutMs: 10, bodyLimitBytes: 32 },
      async () => await factory,
    );
    await expect(source.fetch("github.com/1", new AbortController().signal))
      .rejects.toMatchObject({ failureKind: "upstream_timeout" });
    const controller = new AbortController();
    const aborted = source.fetch("github.com/2", controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    source.forceClose();
    resolveFactory(dispatcher);
    await vi.waitFor(() => expect(destroy).toHaveBeenCalled());
  });

  it("keeps an established model dispatcher across ordinary HTTP failures", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(503).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"data\":[]}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP server address");
    }
    let factoryCalls = 0;
    const source = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: `http://127.0.0.1:${address.port}` }),
      fetch,
      { connectTimeoutMs: 100, totalTimeoutMs: 1_000, bodyLimitBytes: 32 },
      () => {
        factoryCalls += 1;
        return new Agent({ connections: 1, pipelining: 1 });
      },
    );
    try {
      await expect(source.fetch("github.com/1", new AbortController().signal)).rejects.toMatchObject({ status: 503 });
      await expect(source.fetch("github.com/1", new AbortController().signal)).resolves.toEqual({ data: [] });
      expect(factoryCalls).toBe(1);
    } finally {
      await source.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("closes a dispatcher that is created after graceful shutdown starts", async () => {
    let resolveFactory: (dispatcher: Agent) => void = () => undefined;
    const factory = new Promise<Agent>((resolve) => {
      resolveFactory = resolve;
    });
    const dispatcher = new Agent();
    const close = vi.spyOn(dispatcher, "close");
    const source = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: "http://127.0.0.1:1" }),
      fetch,
      { connectTimeoutMs: 20, totalTimeoutMs: 100, bodyLimitBytes: 32 },
      async () => await factory,
    );
    const fetchPending = source.fetch("github.com/1", new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closing = source.close();
    resolveFactory(dispatcher);
    await closing;
    await expect(fetchPending).rejects.toMatchObject({ name: "AbortError" });
    expect(close).toHaveBeenCalled();
    await expect(source.fetch("github.com/1", new AbortController().signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("destroys a dispatcher that is created after force-close wins initialization", async () => {
    let resolveFactory: (dispatcher: Agent) => void = () => undefined;
    const factory = new Promise<Agent>((resolve) => {
      resolveFactory = resolve;
    });
    const dispatcher = new Agent();
    const destroy = vi.spyOn(dispatcher, "destroy");
    const source = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: "http://127.0.0.1:1" }),
      fetch,
      { connectTimeoutMs: 20, totalTimeoutMs: 100, bodyLimitBytes: 32 },
      async () => await factory,
    );
    const fetchPending = source.fetch("github.com/1", new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    source.forceClose();
    resolveFactory(dispatcher);
    await expect(fetchPending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(destroy).toHaveBeenCalled());
  });

  it("force-closes a pending model dispatcher already claimed by graceful shutdown", async () => {
    let resolveFactory: (dispatcher: Agent) => void = () => undefined;
    const factory = new Promise<Agent>((resolve) => {
      resolveFactory = resolve;
    });
    const dispatcher = new Agent();
    const destroy = vi.spyOn(dispatcher, "destroy");
    const source = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: "http://127.0.0.1:1" }),
      fetch,
      { connectTimeoutMs: 20, totalTimeoutMs: 100, bodyLimitBytes: 32 },
      async () => await factory,
    );
    const fetchPending = source.fetch("github.com/1", new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closing = source.close();
    source.forceClose();
    resolveFactory(dispatcher);
    await closing;
    await expect(fetchPending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(destroy).toHaveBeenCalled());
  });

  it("retains a model dispatcher rejected by graceful close until force-close destroys it", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"data\":[]}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP server address");
    }
    const dispatcher = new Agent({ connections: 1, pipelining: 1 });
    vi.spyOn(dispatcher, "close").mockRejectedValue(new Error("dispatcher close failed"));
    const destroy = vi.spyOn(dispatcher, "destroy");
    const source = new HttpCopilotModelsSource(
      async () => ({ token: "token", endpoint: `http://127.0.0.1:${address.port}` }),
      fetch,
      { connectTimeoutMs: 100, totalTimeoutMs: 1_000, bodyLimitBytes: 32 },
      () => dispatcher,
    );
    try {
      await source.fetch("github.com/1", new AbortController().signal);
      await expect(source.close()).rejects.toThrow("dispatcher close failed");
      expect(destroy).not.toHaveBeenCalled();
      source.forceClose();
      await vi.waitFor(() => expect(destroy).toHaveBeenCalled());
    } finally {
      source.forceClose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("model resolver", () => {
  const discovered = {
    accountId: "github.com/1",
    fetchedAt: "t",
    generation: 1,
    credentialGeneration: 1,
    models: parseCapiModels({
      data: [{
        id: "gpt",
        name: "GPT",
        vendor: "x",
        model_picker_enabled: true,
        capabilities: { supported_endpoints: ["/chat/completions"] },
      }],
    }),
  };
  it("uses valid visible preference only when model is missing", async () => {
    const catalog = await registrySnapshotFromDiscovery(bound("github.com/1"), discovered);
    const resolved = resolveModel(catalog, undefined, { modelId: "gpt", validity: "valid" });
    expect(resolved).toMatchObject({ source: "preferred", upstreamModel: "gpt" });
    expect(resolveModel(catalog, undefined, { modelId: "gpt", validity: "invalid" })).toEqual({ kind: "invalid_request" });
    expect(resolveModel(catalog, "nope", { modelId: "gpt", validity: "valid" })).toEqual({ kind: "model_not_found" });
    expect(resolveModel(catalog, "", null)).toEqual({ kind: "invalid_request" });
  });
});

describe("listing routes", () => {
  it("serializes one snapshot as OpenAI and Anthropic shapes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-cat-"));
    const database = openDatabase({
      path: path.join(dir, "state.db"),
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
      nowMs,
    });
    const accounts = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
    await accounts.upsertAuthenticated({
      host: "github.com",
      userId: "1",
      secret: { generation: 0, githubToken: "t" },
    });
    const catalog = new CopilotModelCatalog({
      async fetch() {
        return CAPI;
      },
    }, () => new Date("2026-08-30T05:00:00.000Z"));
    const gw = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: dir }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, createModelCatalogRoutes({
      directory: accounts,
      registry: testModelCapabilityRegistry(catalog),
      preferences: accounts.preferences,
    }));
    try {
      const openai = await gw.fetch(new Request("http://127.0.0.1:31400/v1/models"));
      expect(openai.status).toBe(200);
      const openaiBody = JSON.parse(await openai.text()) as { object: string; data: Array<{ id: string; owned_by: string; created: number }> };
      expect(openaiBody.object).toBe("list");
      expect(openaiBody.data[0]).toMatchObject({ id: "keep", owned_by: "openai", created: 1_677_610_602 });
      expect(openai.headers.get("cache-control")).toBe("no-store");

      const anthropic = await gw.fetch(new Request("http://127.0.0.1:31400/v1/models", {
        headers: { "anthropic-version": "" },
      }));
      const anthropicBody = JSON.parse(await anthropic.text()) as { first_id: string; data: Array<{ type: string; max_tokens: null }> };
      expect(anthropicBody.first_id).toBe("keep");
      expect(anthropicBody.data[0]?.type).toBe("model");
      expect(anthropicBody.data[0]?.max_tokens).toBeNull();

      expect((await gw.fetch(new Request("http://127.0.0.1:31400/models"))).status).toBe(404);
    } finally {
      await gw.close();
      closeDatabase(database);
    }
  });
});

describe("serializers", () => {
  it("omits routing metadata from public OpenAI objects", async () => {
    const discovered = {
      accountId: "a",
      fetchedAt: "2026-08-30T05:00:00Z",
      generation: 1,
      credentialGeneration: 1,
      models: parseCapiModels({ data: [{
        id: "m", name: "M", vendor: "v", model_picker_enabled: true,
        capabilities: { supported_endpoints: ["/v1/responses"] },
      }] }),
    };
    const catalog = await registrySnapshotFromDiscovery(bound("a"), discovered);
    const openai = JSON.parse(serializeOpenAiModels(catalog)) as { data: Array<Record<string, unknown>> };
    expect(openai.data[0]?.supported_endpoints).toBeUndefined();
    expect(openai.data[0]?.supportedEndpoints).toBeUndefined();
    expect(openai.data[0]?.routing).toBeUndefined();
    expect(openai.data[0]?.mode).toBeUndefined();

    const anthropic = JSON.parse(serializeAnthropicModels(catalog)) as { data: Array<Record<string, unknown>> };
    expect(anthropic.data[0]?.display_name).toBe("m");
    expect(anthropic.data[0]?.supported_endpoints).toBeUndefined();
    expect(anthropic.data[0]?.supportedEndpoints).toBeUndefined();
    expect(anthropic.data[0]?.routing).toBeUndefined();
    expect(anthropic.data[0]?.mode).toBeUndefined();
  });
});

function bound(accountId: string) {
  return {
    accountId,
    environment: {
      kind: "github.com" as const,
      host: "github.com" as const,
      webBaseUrl: "https://github.com" as const,
      apiBaseUrl: "https://api.github.com" as const,
      clientId: "Iv1.b507a08c87ecfe98" as const,
      deviceCodeUrl: "https://github.com/login/device/code" as const,
      accessTokenUrl: "https://github.com/login/oauth/access_token" as const,
    },
    userId: "1",
    login: null,
    displayName: null,
    credentialGeneration: 1,
  };
}
