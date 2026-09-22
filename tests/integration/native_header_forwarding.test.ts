import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import { createConnection, createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { createOpenaiChatCompletionsRoute } from "../../src/protocols/openai_chat_completions/endpoint.js";
import { createAnthropicMessagesRoute } from "../../src/protocols/anthropic_messages/endpoint.js";
import { createOpenaiResponsesRoute } from "../../src/protocols/openai_responses/endpoint.js";
import { createModelCatalogRoutes } from "../../src/protocols/model_catalog/routes.js";
import type { ResponsesHistory } from "../../src/protocols/openai_responses/history.js";
import { closeAll, startHttpCopilot, withSetupCleanup } from "../../scripts/tooling/test_support/http_copilot.js";
import { testModelCapabilityRegistry } from "../contract/model_capability_registry_harness.js";

const encoder = new TextEncoder();
const EMPTY_HISTORY: ResponsesHistory = {
  async resolve() { return { kind: "none" }; },
  async enrich(request) { return request; },
  async recordReceipt() {},
  async recordCheckpoint() {},
};

describe("native header forwarding over loopback", () => {
  const closing: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await closeAll(closing.splice(0));
  });

  it("captures duplicate order before Headers normalization and filters client-owned metadata", async () => {
    const opened = await chatGateway();
    closing.push(opened.close);
    const { port } = await opened.gateway.listen();
    const response = await rawPost(port, "/v1/chat/completions", { model: "native-chat", messages: [] }, [
      ["Content-Type", "application/json"],
      ["X-Vendor-Feature", "first"],
      ["openai-beta", "assistants=v2"],
      ["x-vendor-feature", "second"],
      ["Authorization", "Bearer client-secret"],
      ["Cookie", "private-cookie"],
      ["X-Forwarded-For", "127.0.0.1"],
      ["Traceparent", "private-trace"],
      ["X-GHCG-Private", "private-gateway"],
      ["Connection", "x-remove"],
      ["X-Remove", "private-hop"],
      ["User-Agent", "client-agent"],
    ]);
    expect(response.status).toBe(200);
    const upstream = opened.upstream.requests[0];
    const forwarded = upstream?.rawHeaderFields.filter(({ name }) => (
      name.toLowerCase() === "x-vendor-feature" || name.toLowerCase() === "openai-beta"
    ));
    expect(forwarded?.map(({ name, value }) => ({ name: name.toLowerCase(), value }))).toEqual([
      { name: "x-vendor-feature", value: "first" },
      { name: "openai-beta", value: "assistants=v2" },
      { name: "x-vendor-feature", value: "second" },
    ]);
    expect(upstream?.headers.get("authorization")).toBe("Bearer http-test-t");
    expect(upstream?.headers.get("cookie")).toBeNull();
    expect(upstream?.headers.get("x-forwarded-for")).toBeNull();
    expect(upstream?.headers.get("traceparent")).toBeNull();
    expect(upstream?.headers.get("x-ghcg-private")).toBeNull();
    expect(upstream?.headers.get("x-remove")).toBeNull();
    expect(upstream?.headers.get("user-agent")).not.toBe("client-agent");
  });

  it.each([
    ["/v1/messages", { model: "native-messages", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }],
    ["/v1/responses", { model: "native-responses", input: "hi" }],
  ] as const)("forwards safe headers on the native %s loopback path", async (path, body) => {
    const opened = await nativeGateway();
    closing.push(opened.close);
    const { port } = await opened.gateway.listen();
    const response = await rawPost(port, path, body, [
      ["Content-Type", "application/json"],
      ["X-Vendor-Feature", "enabled"],
      ...(path === "/v1/messages" ? [["Anthropic-Version", "2023-06-01"]] as const : []),
    ]);
    expect(response.status).toBe(200);
    expect(opened.upstream.requests[0]?.headers.get("x-vendor-feature")).toBe("enabled");
  });

  it("uses normalized safe header fields for direct Gateway.fetch calls", async () => {
    const opened = await chatGateway();
    closing.push(opened.close);
    const headers = new Headers({ "content-type": "application/json" });
    headers.append("x-vendor-feature", "first");
    headers.append("x-vendor-feature", "second");
    const response = await opened.gateway.fetch(new Request("http://127.0.0.1:31400/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "native-chat", messages: [] }),
    }));
    expect(response.status).toBe(200);
    await response.text();
    expect(opened.upstream.requests[0]?.headers.get("x-vendor-feature")).toBe("first, second");
  });

  it("returns a sanitized client error when captured metadata exceeds its field limit", async () => {
    const opened = await chatGateway();
    closing.push(opened.close);
    const { port } = await opened.gateway.listen();
    const excess = Array.from({ length: 129 }, (_, index) => [`X-Limit-${index}`, "v"] as const);
    const response = await rawPost(port, "/v1/chat/completions", { model: "native-chat", messages: [] }, [
      ["Content-Type", "application/json"],
      ...excess,
    ]);
    expect(response.status).toBe(400);
    expect(response.body).toContain("invalid request");
    expect(response.body).not.toContain("X-Limit");
    expect(opened.upstream.requests).toEqual([]);
  });

  it("returns a sanitized client error when captured metadata exceeds its byte limit", async () => {
    const opened = await chatGateway();
    closing.push(opened.close);
    const { port } = await opened.gateway.listen();
    const response = await rawPost(port, "/v1/chat/completions", { model: "native-chat", messages: [] }, [
      ["Content-Type", "application/json"],
      ["X-Limit", "x".repeat(16 * 1024)],
    ]);
    expect(response.status).toBe(400);
    expect(response.body).toContain("invalid request");
    expect(response.body).not.toContain("X-Limit");
    expect(opened.upstream.requests).toEqual([]);
  });

  it("does not apply inference header limits to the model catalog route", async () => {
    const opened = await nativeGateway();
    closing.push(opened.close);
    const { port } = await opened.gateway.listen();
    const response = await rawRequest(port, "/v1/models", Array.from(
      { length: 129 },
      (_, index) => [`X-Limit-${index}`, "v"] as const,
    ));
    expect(response.status).toBe(200);
  });
});

async function chatGateway() {
  return await nativeGateway();
}

async function nativeGateway() {
  return await withSetupCleanup(async (own) => {
    const database = openDatabase({
      path: ":memory:",
      migrations: [embedMigration(runtimeConfigMigration), embedMigration(accountsMigration)],
    });
    own(() => closeDatabase(database));
    const credentials = new MemoryCredentialStore();
    const coordinator = new AccountCoordinator();
    const directory = new AccountDirectory(database, credentials, coordinator);
    await directory.upsertAuthenticated({
      host: "github.com",
      userId: "1",
      secret: { generation: 0, githubToken: "t" },
    });
    const catalog = new CopilotModelCatalog({
      async fetch() {
        return { data: [{
          id: "native-chat", name: "Native Chat", vendor: "test", model_picker_enabled: true,
          model_info: { supported_endpoints: ["/chat/completions"], chat_output_token_field: "max_tokens" },
        }, {
          id: "native-messages", name: "Native Messages", vendor: "test", model_picker_enabled: true,
          model_info: { supported_endpoints: ["/v1/messages"] },
        }, {
          id: "native-responses", name: "Native Responses", vendor: "test", model_picker_enabled: true,
          model_info: { supported_endpoints: ["/responses"] },
        }] };
      },
    });
    const http = await startHttpCopilot({
      credentials,
      accountCoordinator: coordinator,
      nowMs: Date.now,
      expectations: [{
        method: "POST",
        path: "/chat/completions",
        body: () => true,
        reply: { body: encoder.encode("{\"id\":\"chatcmpl_1\",\"choices\":[]}") },
      }, {
        method: "POST",
        path: "/v1/messages",
        body: () => true,
        reply: { body: encoder.encode("{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"native-messages\",\"content\":[],\"stop_reason\":\"end_turn\",\"stop_sequence\":null,\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}") },
      }, {
        method: "POST",
        path: "/responses",
        body: () => true,
        reply: { body: encoder.encode("{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[]}") },
      }],
    });
    own(() => http.close());
    const registry = testModelCapabilityRegistry(catalog);
    own(() => registry.close());
    const port = await availablePort();
    const gateway = await createGateway({
      startup: parseStartupConfig(["--port", String(port)], {}, { homedir: "." }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, [
      createOpenaiChatCompletionsRoute({ directory, registry, copilot: http.backend }),
      createAnthropicMessagesRoute({
        directory,
        registry,
        preferences: directory.preferences,
        copilot: http.backend,
      }),
      createOpenaiResponsesRoute({
        directory,
        registry,
        preferences: directory.preferences,
        copilot: http.backend,
        history: EMPTY_HISTORY,
      }),
      ...createModelCatalogRoutes({ directory, registry, preferences: directory.preferences }),
    ]);
    own(() => gateway.close());
    return {
      gateway,
      upstream: http.upstream,
      close: async () => await closeAll([
        () => gateway.close(),
        () => registry.close(),
        () => http.close(),
        () => closeDatabase(database),
      ]),
    };
  });
}

async function rawPost(
  port: number,
  path: string,
  requestBody: unknown,
  headers: readonly (readonly [string, string])[],
): Promise<{
  readonly status: number;
  readonly body: string;
}> {
  const body = JSON.stringify(requestBody);
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      const wireHeaders = [
        `POST ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        ...headers.map(([name, value]) => `${name}: ${value}`),
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: close",
      ];
      socket.write(`${wireHeaders.join("\r\n")}\r\n\r\n${body}`);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const response = Buffer.concat(chunks).toString("utf8");
      const separator = response.indexOf("\r\n\r\n");
      const status = Number(response.match(/^HTTP\/1\.1 (\d{3})/u)?.[1] ?? 0);
      resolve({ status, body: separator < 0 ? "" : response.slice(separator + 4) });
    });
  });
}

async function rawRequest(
  port: number,
  path: string,
  headers: readonly (readonly [string, string])[],
): Promise<{ readonly status: number; readonly body: string }> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      const wireHeaders = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        ...headers.map(([name, value]) => `${name}: ${value}`),
        "Connection: close",
      ];
      socket.write(`${wireHeaders.join("\r\n")}\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const response = Buffer.concat(chunks).toString("utf8");
      const separator = response.indexOf("\r\n\r\n");
      const status = Number(response.match(/^HTTP\/1\.1 (\d{3})/u)?.[1] ?? 0);
      resolve({ status, body: separator < 0 ? "" : response.slice(separator + 4) });
    });
  });
}

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("listener unavailable");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
