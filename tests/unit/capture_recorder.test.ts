import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { resolveGitHubEnvironment } from "../../src/accounts/github_environment.js";
import { HttpCopilotBackend } from "../../src/copilot/transport.js";
import { invalidateEndpoint } from "../../src/copilot/endpoint_discovery.js";
import { recordCapture, type CaptureOptions } from "../../scripts/tooling/capture_recorder.js";
import { expectedForecastArguments } from "../../scripts/tooling/capture_scenarios.js";

type Protocol = "chat" | "responses" | "messages";
const models = { chat: "gemini-3.5-flash", responses: "gpt-5.5", messages: "claude-sonnet-4" } as const;
const text = "Synthetic production guidance with a complete conclusion. ".repeat(30);
const outputs: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  for (const output of outputs.splice(0)) await rm(path.dirname(output), { recursive: true, force: true });
});

async function remote(protocol: Protocol, respond?: (response: ServerResponse, body: Record<string, unknown>, index: number) => void) {
  const seen: Array<{ path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    seen.push({ path: request.url!, headers: request.headers, body });
    if (respond) return respond(response, body, seen.length - 1);
    const wantsTools = body.tool_choice === "required" || (body.tool_choice as { type?: string } | undefined)?.type === "any";
    const content = envelope(protocol, wantsTools);
    response.setHeader("content-type", body.stream ? "text/event-stream" : "application/json");
    const bytes = Buffer.from(body.stream ? frames(protocol, content) : JSON.stringify(content));
    // Split UTF-8/JSON/SSE boundaries, not just complete records.
    for (let offset = 0; offset < bytes.length; offset += 31) response.write(bytes.subarray(offset, offset + 31));
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test listener unavailable");
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const accountId = `capture-test-${address.port}`;
  const credentials = new MemoryCredentialStore();
  await credentials.putGeneration(accountId, 1, {
    generation: 1, githubToken: "synthetic-github", copilotToken: "synthetic-copilot", copilotExpiresAtMs: Date.now() + 3_600_000,
  });
  const backend = new HttpCopilotBackend({
    credentials,
    refreshCopilotToken: async () => { throw new Error("unexpected token refresh"); },
    fetchDiscovery: async () => `http://127.0.0.1:${address.port}`,
  });
  cleanup.push(async () => { await backend.close(); invalidateEndpoint(accountId); });
  let binds = 0;
  return {
    seen, backend,
    bind: async (signal: AbortSignal) => {
      binds += 1;
      return backend.bind({ accountId, environment: resolveGitHubEnvironment("github.com"), userId: "1", login: "synthetic", displayName: "Synthetic", credentialGeneration: 1 }, signal);
    },
    binds: () => binds,
  };
}

function envelope(protocol: Protocol, tools = false): Record<string, unknown> {
  const calls = ["Tokyo", "Paris"].map((city, index) => ({
    id: `call-${index}`, name: "get_hourly_forecast", arguments: JSON.stringify(expectedForecastArguments(city as "Tokyo" | "Paris")),
  }));
  if (protocol === "chat") return {
    id: "chat-test", object: "chat.completion", model: models.chat,
    choices: [{ index: 0, message: { role: "assistant", content: tools ? null : text, ...(tools ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}) }, finish_reason: tools ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
  };
  if (protocol === "messages") return {
    id: "msg-test", type: "message", role: "assistant", model: models.messages,
    content: tools ? calls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: JSON.parse(call.arguments) })) : [{ type: "text", text }],
    stop_reason: tools ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 200 },
  };
  return {
    id: "resp-test", object: "response", model: models.responses, status: "completed",
    output: tools ? calls.map((call) => ({ type: "function_call", id: `item-${call.id}`, call_id: call.id, name: call.name, arguments: call.arguments, status: "completed" })) : [{ type: "message", id: "item-text", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
  };
}

function frames(protocol: Protocol, value: Record<string, unknown>): string {
  const sse = (event: string | undefined, data: unknown) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
  if (protocol === "chat") {
    const choice = (value.choices as Array<{ message: Record<string, unknown>; finish_reason: string }>)[0]!;
    const calls = choice.message.tool_calls as object[] | undefined;
    const delta = calls ? { tool_calls: calls.map((call, index) => ({ index, ...call })) } : { content: text };
    return sse(undefined, { id: value.id, choices: [{ index: 0, delta, finish_reason: null }] })
      + sse(undefined, { id: value.id, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], usage: value.usage })
      + "data: [DONE]\n\n";
  }
  if (protocol === "responses") {
    let result = sse("response.created", { type: "response.created", response: { ...value, status: "in_progress", output: [] } });
    for (const [output_index, item] of (value.output as Array<Record<string, unknown>>).entries()) {
      result += sse("response.output_item.added", { type: "response.output_item.added", output_index, item: { ...item, status: "in_progress", ...(item.type === "message" ? { content: [] } : { arguments: "" }) } });
      result += item.type === "message"
        ? sse("response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index, content_index: 0, delta: text })
        : sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: item.arguments });
      result += sse("response.output_item.done", { type: "response.output_item.done", output_index, item });
    }
    return result + sse("response.completed", { type: "response.completed", response: value });
  }
  let result = sse("message_start", { type: "message_start", message: { ...value, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } });
  for (const [index, block] of (value.content as Array<Record<string, unknown>>).entries()) {
    result += sse("content_block_start", { type: "content_block_start", index, content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} } });
    result += sse("content_block_delta", { type: "content_block_delta", index, delta: block.type === "text" ? { type: "text_delta", text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
    result += sse("content_block_stop", { type: "content_block_stop", index });
  }
  return result + sse("message_delta", { type: "message_delta", delta: { stop_reason: value.stop_reason, stop_sequence: null }, usage: { output_tokens: 200 } })
    + sse("message_stop", { type: "message_stop" });
}

const options = (protocol: Protocol, extra: Partial<CaptureOptions> = {}): CaptureOptions => ({
  execute: true, model: models[protocol], scenario: "all", mode: "both", ...extra,
});

describe("explicit native Copilot recorder", () => {
  it("defaults to a content-free plan without binding or filesystem writes", async () => {
    const result = await recordCapture({}, { bind: async () => { throw new Error("must not bind"); } });
    expect(result).toMatchObject({ executed: false, model: models.chat, protocol: "chat", requests: 16 });
    expect(result).not.toHaveProperty("outputDirectory");
    expect(JSON.stringify(result)).not.toMatch(/prompt|authorization|synthetic-copilot/iu);
  });

  it.each(["chat", "responses", "messages"] as const)("records %s both modes through HTTP, all scenarios, full image/tool history and one bind", async (protocol) => {
    const upstream = await remote(protocol);
    const result = await recordCapture(options(protocol), upstream);
    expect(result.executed).toBe(true);
    if (!result.executed) throw new Error("expected execution");
    outputs.push(result.outputDirectory);
    expect(result.exchanges).toHaveLength(16);
    expect(upstream.binds()).toBe(1);
    expect(upstream.backend.inspect().responseLeases).toBe(0);
    expect(upstream.seen.every((request) => request.path === ({ chat: "/chat/completions", responses: "/responses", messages: "/v1/messages" })[protocol])).toBe(true);
    expect(upstream.seen.every((request) => request.body.model === models[protocol])).toBe(true);
    for (const exchange of result.exchanges) {
      const response = await readFile(path.join(result.outputDirectory, exchange.responseFile));
      expect(createHash("sha256").update(response).digest("hex")).toBe(exchange.responseSha256);
      const original = envelope(protocol, exchange.toolCalls > 0);
      expect(response.toString("utf8")).toBe(exchange.mode === "stream" ? frames(protocol, original) : JSON.stringify(original));
      expect(exchange).toMatchObject({ status: 200, terminal: "completed", usage: { inputTokens: 100, outputTokens: 200 } });
      if (exchange.scenario === "five-turn") {
        expect(exchange.hasVisionInput).toBe(true);
        const request = JSON.parse(await readFile(path.join(result.outputDirectory, exchange.requestFile), "utf8")) as Record<string, unknown>;
        const history = JSON.stringify(request);
        expect(history).toContain(protocol === "messages" ? "base64" : "data:image/jpeg;base64,");
        if (exchange.turn >= 3) {
          expect(history).toContain("call-0");
          expect(history).toContain("call-1");
          expect(history).toContain("precipitation_probability");
          expect(history).toContain("Synthetic production guidance");
        }
      }
    }
    if (protocol !== "messages") {
      expect(upstream.seen.filter((request) => JSON.stringify(request.body).includes("data:image/jpeg;base64,")).every((request) => request.headers["copilot-vision-request"] === "true")).toBe(true);
    } else {
      expect(upstream.seen.every((request) => request.headers["anthropic-version"] === "2023-06-01")).toBe(true);
    }
    expect(await readdir(path.dirname(result.outputDirectory))).toEqual(["capture"]);
    expect(await readFile(path.join(result.outputDirectory, "manifest.json"), "utf8")).not.toMatch(/synthetic-copilot|synthetic-github|authorization|Synthetic production guidance/iu);
  });

  it("records a native Chat response with an omitted optional object field without rewriting bytes", async () => {
    const value = envelope("chat");
    delete value.object;
    const source = JSON.stringify(value);
    const upstream = await remote("chat", (response) => {
      response.setHeader("content-type", "application/json");
      response.end(source);
    });
    const result = await recordCapture(options("chat", { scenario: "long-text", mode: "nonstream" }), upstream);
    if (!result.executed) throw new Error("expected execution");
    outputs.push(result.outputDirectory);
    expect(await readFile(path.join(result.outputDirectory, result.exchanges[0]!.responseFile), "utf8")).toBe(source);
  });

  it("rejects an explicitly wrong Chat envelope with content-free step evidence", async () => {
    const upstream = await remote("chat", (response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ...envelope("chat"), object: "unexpected" }));
    });
    await expect(recordCapture(options("chat", { scenario: "long-text", mode: "nonstream" }), upstream)).rejects.toMatchObject({
      code: "capture_invalid_response", step: { scenario: "long-text", mode: "nonstream", turn: 1 },
    });
  });

  it.each(["chat", "responses", "messages"] as const)("rejects %s truncated streams without publishing and releases transport", async (protocol) => {
    const upstream = await remote(protocol, (response) => {
      response.setHeader("content-type", "text/event-stream");
      response.end(frames(protocol, envelope(protocol)).replace(/(?:event: [^\n]+\n)?data: [^\n]+\n\n$/u, ""));
    });
    await expect(recordCapture(options(protocol, { scenario: "long-text", mode: "stream" }), upstream)).rejects.toThrow("capture_invalid_response");
    expect(upstream.backend.inspect().responseLeases).toBe(0);
  });

  it.each(["chat", "responses", "messages"] as const)("rejects %s buffered truncation", async (protocol) => {
    const upstream = await remote(protocol, (response) => {
      const value = envelope(protocol);
      if (protocol === "chat") (value.choices as Array<Record<string, unknown>>)[0]!.finish_reason = "length";
      else if (protocol === "messages") value.stop_reason = "max_tokens";
      else { value.status = "incomplete"; value.incomplete_details = { reason: "max_output_tokens" }; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(value));
    });
    await expect(recordCapture(options(protocol, { scenario: "long-text", mode: "nonstream" }), upstream)).rejects.toThrow("capture_invalid_response");
  });

  it("sanitizes HTTP errors without retry, fallback, or response diagnostics", async () => {
    const upstream = await remote("chat", (response) => { response.writeHead(429); response.end("private provider diagnostic synthetic-copilot"); });
    await expect(recordCapture(options("chat", { scenario: "long-text", mode: "stream" }), upstream)).rejects.toMatchObject({
      message: "capture_http_status", status: 429, step: { scenario: "long-text", mode: "stream", turn: 1 },
    });
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.backend.inspect().responseLeases).toBe(0);
  });

  it("bounds idle streaming and cancellation and leaves no response lease", async () => {
    const upstream = await remote("messages", (response) => { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": waiting\n\n"); });
    await expect(recordCapture(options("messages", { scenario: "long-text", mode: "stream", idleTimeoutMs: 30 }), upstream)).rejects.toThrow("capture_timeout");
    expect(upstream.backend.inspect().responseLeases).toBe(0);
  });

  it("bounds the response and validates every turn before any publication", async () => {
    const upstream = await remote("chat");
    await expect(recordCapture(options("chat", { scenario: "long-text", mode: "stream", maxBodyBytes: 128 }), upstream)).rejects.toThrow("capture_body_limit");
    expect(upstream.backend.inspect().responseLeases).toBe(0);
  });

  it.each(["chat", "responses", "messages"] as const)("rejects %s post-terminal data, malformed SSE and missing usage", async (protocol) => {
    const invalidBodies = [
      frames(protocol, envelope(protocol)) + "data: {\"error\":\"private-diagnostic\"}\n\n",
      frames(protocol, envelope(protocol)) + "data: {",
      frames(protocol, { ...envelope(protocol), usage: {} }).replaceAll("\"input_tokens\":100", "\"input_tokens\":0").replaceAll("\"output_tokens\":200", "\"output_tokens\":0"),
    ];
    for (const body of invalidBodies) {
      const upstream = await remote(protocol, (response) => {
        response.setHeader("content-type", "text/event-stream");
        response.end(body);
      });
      await expect(recordCapture(options(protocol, { scenario: "long-text", mode: "stream" }), upstream)).rejects.toThrow("capture_invalid_response");
      expect(upstream.backend.inspect().responseLeases).toBe(0);
    }
  });

  it("rejects stream error, oversized event, bad UTF-8, wrong media type and invalid nested tools", async () => {
    const cases = [
      { type: "text/event-stream", body: Buffer.from("event: error\ndata: {\"type\":\"error\",\"error\":\"private diagnostic\"}\n\n") },
      { type: "text/event-stream", body: Buffer.from(`data: ${"x".repeat(1_048_577)}\n\n`) },
      { type: "text/event-stream", body: Buffer.from([0xff, 0xfe]) },
      { type: "application/json", body: Buffer.from(frames("messages", envelope("messages"))) },
      { type: "text/event-stream", body: Buffer.from(frames("messages", envelope("messages", true)).replaceAll("Tokyo", "UnknownCity")) },
    ];
    for (const item of cases) {
      const upstream = await remote("messages", (response) => { response.setHeader("content-type", item.type); response.end(item.body); });
      await expect(recordCapture(options("messages", { scenario: "parallel-tools", mode: "stream" }), upstream)).rejects.toThrow("capture_invalid_response");
      expect(upstream.backend.inspect().responseLeases).toBe(0);
    }
  });

  it("rolls back a later failed turn and cannot replace an earlier successful capture", async () => {
    const upstream = await remote("chat");
    const success = await recordCapture(options("chat", { scenario: "long-text", mode: "nonstream" }), upstream);
    if (!success.executed) throw new Error("expected execution");
    outputs.push(success.outputDirectory);
    const original = await readFile(path.join(success.outputDirectory, success.exchanges[0]!.responseFile));
    const captureDirectories = async () => (await readdir(tmpdir())).filter((name) => name.startsWith(`ghcg-capture-${process.pid}-`)).sort();
    const before = await captureDirectories();
    const failing = await remote("chat", (response, _body, index) => {
      response.setHeader("content-type", "application/json");
      response.end(index === 1 ? "{\"error\":\"private diagnostic\"}" : JSON.stringify(envelope("chat")));
    });
    await expect(recordCapture(options("chat", { scenario: "five-turn", mode: "nonstream" }), failing)).rejects.toThrow("capture_invalid_response");
    expect(failing.seen).toHaveLength(2);
    expect(await captureDirectories()).toEqual(before);
    expect(await readFile(path.join(success.outputDirectory, success.exchanges[0]!.responseFile))).toEqual(original);
  });

  it("bounds buffered reads, total bind time and caller cancellation", async () => {
    const upstream = await remote("responses", (response) => { response.writeHead(200, { "content-type": "application/json" }); response.write("{"); });
    await expect(recordCapture(options("responses", { scenario: "long-text", mode: "nonstream", requestTimeoutMs: 30 }), upstream)).rejects.toThrow("capture_timeout");
    expect(upstream.backend.inspect().responseLeases).toBe(0);
    await expect(recordCapture(options("responses", { scenario: "long-text", totalTimeoutMs: 30 }), { bind: async () => new Promise(() => undefined) })).rejects.toThrow("capture_timeout");
    const controller = new AbortController();
    controller.abort(new Error("private cancellation reason"));
    await expect(recordCapture(options("responses", { signal: controller.signal }), upstream)).rejects.toThrow(/^capture_cancelled$/u);
  });

  it("rejects unconfigured models/options before binding", async () => {
    let binds = 0;
    const bind = async () => { binds += 1; throw new Error("must not bind"); };
    await expect(recordCapture({ execute: true, model: "alternate-provider" }, { bind })).rejects.toThrow("capture_invalid_options");
    await expect(recordCapture({ execute: true, totalTimeoutMs: 0 }, { bind })).rejects.toThrow("capture_invalid_options");
    expect(binds).toBe(0);
  });
});
