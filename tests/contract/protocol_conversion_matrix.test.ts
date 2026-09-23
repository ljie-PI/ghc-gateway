import { AccountCoordinator } from "../../src/accounts/account_coordinator.js";
import { describe, expect, it } from "vitest";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { withSetupCleanup, startHttpCopilot, closeAll, jsonStream } from "../../scripts/tooling/test_support/http_copilot.js";
import type { CopilotHttpMock } from "../../scripts/tooling/test_support/copilot_http.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway, type Gateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { migration as responsesHistoryMigration } from "../../src/persistence/migrations/030_responses_history.js";
import { migration as responsesContinuationMigration } from "../../src/persistence/migrations/041_responses_continuation_ownership.js";
import { migration as reasoningCarriersMigration } from "../../src/persistence/migrations/042_responses_reasoning_carriers.js";
import { createAnthropicMessagesRoute } from "../../src/protocols/anthropic_messages/endpoint.js";
import { createOpenaiChatCompletionsRoute } from "../../src/protocols/openai_chat_completions/endpoint.js";
import { createOpenaiResponsesRoute } from "../../src/protocols/openai_responses/endpoint.js";
import { SqliteResponsesHistory } from "../../src/protocols/openai_responses/history.js";
import { SqliteReasoningCarrierStore } from "../../src/protocols/conversion/reasoning_carriers.js";
import type { ReasoningCarrierStore } from "../../src/protocols/conversion/reasoning_carriers.js";
import { testModelCapabilityRegistry } from "./model_capability_registry_harness.js";
import { DiagnosticRecorder, type DiagnosticRecord } from "../../src/telemetry/diagnostics.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const nowMs = (): number => 1_700_000_000_000;

describe("protocol conversion matrix", () => {
  it.each([
    ["chat", "native-chat", "/chat/completions", true],
    ["messages", "native-messages", "/v1/messages", true],
    ["responses", "native-responses", "/responses", true],
    ["chat", "native-messages", "/v1/messages", false],
    ["chat", "native-responses", "/responses", false],
    ["messages", "native-chat", "/chat/completions", false],
    ["messages", "native-responses", "/responses", false],
    ["responses", "native-chat", "/chat/completions", false],
    ["responses", "native-messages", "/v1/messages", false],
  ] as const)("forwards arbitrary client headers only for native %s -> %s", async (
    source,
    model,
    expectedPath,
    forwarded,
  ) => {
    const harness = await matrixGateway();
    try {
      const request = protocolRequest(source, model);
      request.headers.set("x-vendor-feature", "enabled");
      request.headers.set("openai-beta", "assistants=v2");
      const response = await harness.gw.fetch(request);
      expect(response.status).toBe(200);
      await response.text();
      const upstream = harness.upstream.requests.at(-1);
      expect(upstream?.path).toBe(expectedPath);
      expect(upstream?.headers.get("x-vendor-feature")).toBe(forwarded ? "enabled" : null);
      expect(upstream?.headers.get("openai-beta")).toBe(forwarded ? "assistants=v2" : null);
    } finally {
      await harness.close();
    }
  });

  it.each([false, true])("observes native Responses before validation fails (stream=%s)", async (stream) => {
    const records: DiagnosticRecord[] = [];
    const diagnostics = new DiagnosticRecorder({ write: (record) => records.push(record) });
    const malformed = encoder.encode("PRIVATE_INVALID_JSON");
    const harness = await matrixGateway(false, diagnostics, {
      responsesBody: malformed, responsesStreamContentType: "application/json",
    });
    try {
      const response = await harness.gw.fetch(protocolRequest("responses", "native-responses", { stream }));
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain("PRIVATE");
      await diagnostics.close();
      expect(records.at(-1)).toMatchObject({
        httpStatus: 502, upstreamStatus: 200,
        upstreamBytes: stream ? 0 : malformed.byteLength,
        failure: { kind: "invalid_upstream_response", source: "parser", phase: stream ? "headers" : "body" },
      });
      expect(records.find((record) => record.event === "request_failed")?.stage).toBe("upstream_output");
      expect(JSON.stringify(records)).not.toContain("PRIVATE");
    } finally {
      await harness.close();
      await diagnostics.close();
    }
  });

  it.each([false, true])("attributes valid but unmappable upstream citations to conversion (stream=%s)", async (stream) => {
    const citation = {
      type: "url_citation", url: "https://example.test/source", title: "Source", start_index: 0, end_index: 6,
    };
    const records: DiagnosticRecord[] = [];
    const diagnostics = new DiagnosticRecorder({ write: (record) => records.push(record) });
    const harness = await matrixGateway(false, diagnostics, {
      responsesBody: encoder.encode(JSON.stringify({
        id: "resp_cited", object: "response", status: "completed",
        output: [{
          id: "msg_cited", type: "message", status: "completed", role: "assistant",
          content: [{ type: "output_text", text: "answer", annotations: [citation] }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })),
      responsesStreamBody: Buffer.concat([
        responsesEvent(0, "response.created", {
          response: { id: "resp_cited", object: "response", status: "in_progress", output: [] },
        }),
        responsesEvent(1, "response.output_item.added", {
          output_index: 0,
          item: { id: "msg_cited", type: "message", status: "in_progress", role: "assistant", content: [] },
        }),
        responsesEvent(2, "response.content_part.added", {
          output_index: 0, content_index: 0, item_id: "msg_cited",
          part: { type: "output_text", text: "answer", annotations: [citation] },
        }),
      ]),
    });
    try {
      const response = await harness.gw.fetch(protocolRequest("chat", "native-responses", { stream }));
      expect(response.status).toBe(502);
      const body = await response.text();
      expect(body).toContain("upstream response cannot be converted");
      expect(body).not.toContain("https://example.test/source");
      await diagnostics.close();
      expect(records.at(-1)).toMatchObject({
        httpStatus: 502,
        outcome: "upstream_error",
        failure: { kind: "unsupported_upstream_output", source: "converter" },
      });
    } finally {
      await harness.close();
      await diagnostics.close();
    }
  });

  it.each((["chat", "messages", "responses"] as const).flatMap((client) => (
    (["chat", "messages", "responses"] as const).map((upstream) => ({ client, upstream }))
  )))("retains buffered incomplete status independently of Usage ($client -> $upstream)", async ({ client, upstream }) => {
    const records: DiagnosticRecord[] = [];
    const diagnostics = new DiagnosticRecorder({ write: (record) => records.push(record) });
    const harness = await matrixGateway(false, diagnostics, {
      chatBody: encoder.encode(JSON.stringify({
        id: "chatcmpl_partial", choices: [{ message: { role: "assistant", content: "partial" }, finish_reason: "length" }],
      })),
      messagesBody: encoder.encode(JSON.stringify({
        id: "msg_partial", type: "message", role: "assistant", model: "matrix",
        content: [{ type: "text", text: "partial" }], stop_reason: "max_tokens",
      })),
      responsesBody: encoder.encode(JSON.stringify({
        id: "resp_partial", object: "response", status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "message", id: "msg_partial", role: "assistant", status: "incomplete",
          content: [{ type: "output_text", text: "partial", annotations: [] }] }],
      })),
    });
    try {
      const response = await harness.gw.fetch(protocolRequest(client, `native-${upstream}`));
      expect(response.status).toBe(200);
      await response.text();
      await diagnostics.close();
      expect(records.filter((record) => record.event === "request_finished")).toMatchObject([{
        httpStatus: 200, outcome: "success", protocolStatus: "incomplete",
      }]);
    } finally {
      await harness.close();
      await diagnostics.close();
    }
  });

  it.each((["chat", "messages", "responses"] as const).flatMap((client) => (
    (["chat", "messages", "responses"] as const).flatMap((upstream) => (
      [false, true].map((stream) => ({ client, upstream, stream }))
    ))
  )))("keeps diagnostic $client -> $upstream wire identical (stream=$stream)", async ({ client, upstream, stream }) => {
    const records: DiagnosticRecord[] = [];
    const diagnostics = new DiagnosticRecorder({ write: (record) => records.push(record) }, {
      nowMs, monotonicNowMs: () => 1,
    });
    const plain = await matrixGateway(true);
    const traced = await matrixGateway(true, diagnostics);
    try {
      const input = client === "responses"
        ? { input: "PRIVATE_REQUEST_CANARY", stream }
        : { messages: [{ role: "user", content: "PRIVATE_REQUEST_CANARY" }], stream };
      const baseline = await plain.gw.fetch(protocolRequest(client, `native-${upstream}`, input));
      const observed = await traced.gw.fetch(protocolRequest(client, `native-${upstream}`, input));
      expect(observed.status).toBe(baseline.status);
      expect([...observed.headers]).toEqual([...baseline.headers]);
      expect(await observed.text()).toBe(await baseline.text());
      await diagnostics.close();
      expect(records.filter((record) => record.event === "request_finished")).toMatchObject([{
        requestId: "req_matrix", clientProtocol: client, upstreamProtocol: upstream, httpStatus: 200,
        converted: client !== upstream, stream, outcome: "success",
      }]);
      expect(records.some((record) => record.stage === "request_decoded" && record.shape !== undefined)).toBe(true);
      expect(records.some((record) => record.stage === "upstream_output" && record.shape !== undefined)).toBe(true);
      expect(records.some((record) => record.stage === "client_output" && record.shape !== undefined)).toBe(true);
      if (stream) expect(records.at(-1)?.sse).not.toEqual({});
      const logged = JSON.stringify(records);
      expect(logged).not.toContain("PRIVATE_");
      expect(logged).not.toContain("visible plan");
      expect(logged).not.toContain("provider-signature");
      expect(diagnostics.snapshot().droppedRecords).toBe(0);
    } finally {
      await closeAll([() => plain.close(), () => traced.close(), () => diagnostics.close()]);
    }
  });

  it.each([
    ["chat", "chat", "native-chat", "chat"],
    ["chat", "messages", "native-messages", "messages"],
    ["chat", "responses", "native-responses", "responses"],
    ["messages", "chat", "native-chat", "chat"],
    ["messages", "messages", "native-messages", "messages"],
    ["messages", "responses", "native-responses", "responses"],
    ["responses", "chat", "native-chat", "chat"],
    ["responses", "messages", "native-messages", "messages"],
    ["responses", "responses", "native-responses", "responses"],
  ] as const)(
    "executes %s -> %s with one typed %s operation",
    async (source, _target, model, expectedKind) => {
      const harness = await matrixGateway();
      try {
        const response = await harness.gw.fetch(protocolRequest(source, model));
        expect(response.status).toBe(200);
        expect(response.headers.get("x-ghcg-upstream-protocol")).toBe(expectedKind);
        expect(await response.text()).toContain("ok");
        expect(harness.upstream.requests.map((entry) => [entry.path, JSON.parse(decoder.decode(entry.body)).stream === true])).toEqual([[{ chat: "/chat/completions", messages: "/v1/messages", responses: "/responses" }[expectedKind.replace("-stream", "") as "chat" | "messages" | "responses"], expectedKind.endsWith("-stream")]]);
      } finally {
        await harness.close();
      }
    },
  );

  it.each([
    ["chat", "messages"],
    ["chat", "responses"],
    ["messages", "chat"],
    ["messages", "responses"],
    ["responses", "chat"],
    ["responses", "messages"],
  ] as const)("preserves portable reasoning for converted %s upstream -> %s client", async (upstream, client) => {
    for (const stream of [false, true]) {
      const harness = await matrixGateway(true);
      try {
        const response = await harness.gw.fetch(protocolRequest(client, `native-${upstream}`, {
          stream,
        }));
        expect(response.status).toBe(200);
        expect(response.headers.get("x-ghcg-upstream-protocol")).toBe(upstream);
        const wire = await response.text();
        expect(wire).toContain("ok");
        const visible = client !== "messages";
        if (client === "chat") {
          expect(wire.includes("reasoning_content")).toBe(visible);
        } else if (client === "responses") {
          expect(wire.includes(stream ? "response.reasoning_summary_text.delta" : "\"type\":\"reasoning\"")).toBe(visible);
        } else {
          expect(wire).not.toContain("thinking_delta");
          expect(wire).not.toContain("provider-signature");
        }
        expect(harness.upstream.requests).toHaveLength(1);
      } finally {
        await harness.close();
      }
    }
  });

  it.each([false, true])("records native Responses reasoning diagnostics (stream=%s)", async (stream) => {
    const records: DiagnosticRecord[] = [];
    const diagnostics = new DiagnosticRecorder({ write: (record) => records.push(record) });
    const reasoningItem = {
      id: "rs_diagnostic",
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: "PRIVATE_SUMMARY" }],
      content: [{ type: "reasoning_text", text: "PRIVATE_REASONING" }],
    };
    const completed = {
      id: "resp_diagnostic",
      object: "response",
      status: "completed",
      output: [reasoningItem, {
        id: "msg_diagnostic", type: "message", status: "completed", role: "assistant",
        content: [{ type: "output_text", text: "PRIVATE_OUTPUT", annotations: [] }],
      }],
      usage: {
        input_tokens: 3,
        output_tokens: 19,
        output_tokens_details: { reasoning_tokens: 17 },
        total_tokens: 22,
      },
    };
    const streamBody = Buffer.concat([
      responsesEvent(0, "response.created", { response: { ...completed, status: "in_progress", output: [] } }),
      responsesEvent(1, "response.output_item.added", {
        output_index: 0,
        item: { ...reasoningItem, status: "in_progress", summary: [], content: [] },
      }),
      responsesEvent(2, "response.reasoning_summary_part.added", {
        item_id: "rs_diagnostic", output_index: 0, summary_index: 0,
        part: { type: "summary_text", text: "" },
      }),
      responsesEvent(3, "response.reasoning_summary_text.delta", {
        item_id: "rs_diagnostic", output_index: 0, summary_index: 0, delta: "PRIVATE_SUMMARY",
      }),
      responsesEvent(4, "response.reasoning_summary_text.done", {
        item_id: "rs_diagnostic", output_index: 0, summary_index: 0, text: "PRIVATE_SUMMARY",
      }),
      responsesEvent(5, "response.reasoning_summary_part.done", {
        item_id: "rs_diagnostic", output_index: 0, summary_index: 0,
        part: { type: "summary_text", text: "PRIVATE_SUMMARY" },
      }),
      responsesEvent(6, "response.reasoning_text.delta", {
        item_id: "rs_diagnostic", output_index: 0, content_index: 0, delta: "PRIVATE_REASONING",
      }),
      responsesEvent(7, "response.reasoning_text.done", {
        item_id: "rs_diagnostic", output_index: 0, content_index: 0, text: "PRIVATE_REASONING",
      }),
      responsesEvent(8, "response.output_item.done", { output_index: 0, item: reasoningItem }),
      responsesEvent(9, "response.completed", { response: completed }),
    ]);
    const harness = await matrixGateway(false, diagnostics, {
      responsesBody: encoder.encode(JSON.stringify(completed)),
      responsesStreamBody: streamBody,
    });
    try {
      const response = await harness.gw.fetch(protocolRequest("responses", "native-responses", {
        stream,
        reasoning: { effort: "high", summary: "detailed" },
      }));
      expect(response.status).toBe(200);
      await response.text();
      await diagnostics.close();
      expect(records.at(-1)).toMatchObject({
        reasoningEffort: "high",
        reasoningSummary: "detailed",
        reasoningTokens: 17,
      });
      if (stream) {
        expect(records.at(-1)?.sse).toMatchObject({
          "response.reasoning_summary_part.added": 1,
          "response.reasoning_summary_text.delta": 1,
          "response.reasoning_summary_text.done": 1,
          "response.reasoning_summary_part.done": 1,
          "response.reasoning_text.delta": 1,
          "response.reasoning_text.done": 1,
        });
      }
      expect(JSON.stringify(records)).not.toContain("PRIVATE");
    } finally {
      await harness.close();
      await diagnostics.close();
    }
  });

  it.each([false, true].flatMap((stream) => (
    [undefined, 0, 7].map((reasoningTokens) => ({ stream, reasoningTokens }))
  )))("records converted Responses reported reasoning tokens (stream=$stream, tokens=$reasoningTokens)", async ({
    stream,
    reasoningTokens,
  }) => {
    const records: DiagnosticRecord[] = [];
    const diagnostics = new DiagnosticRecorder({ write: (record) => records.push(record) });
    const usage = {
      prompt_tokens: 3,
      completion_tokens: 8,
      ...(reasoningTokens === undefined
        ? {}
        : { completion_tokens_details: { reasoning_tokens: reasoningTokens } }),
      total_tokens: 11,
    };
    const chatBody = encoder.encode(JSON.stringify({
      id: "chatcmpl_diagnostic",
      choices: [{
        index: 0,
        message: { role: "assistant", reasoning_content: "PRIVATE_REASONING", content: "PRIVATE_OUTPUT" },
        finish_reason: "stop",
      }],
      usage,
    }));
    const chatStreamBody = Buffer.concat([
      encoder.encode(`data: ${JSON.stringify({
        id: "chatcmpl_diagnostic", choices: [{
          index: 0, delta: { role: "assistant", reasoning_content: "PRIVATE_REASONING" }, finish_reason: null,
        }],
      })}\n\n`),
      encoder.encode(`data: ${JSON.stringify({
        id: "chatcmpl_diagnostic", choices: [{
          index: 0, delta: { content: "PRIVATE_OUTPUT" }, finish_reason: "stop",
        }],
        usage,
      })}\n\n`),
      encoder.encode("data: [DONE]\n\n"),
    ]);
    const harness = await matrixGateway(false, diagnostics, { chatBody, chatStreamBody });
    try {
      const response = await harness.gw.fetch(protocolRequest("responses", "native-chat", {
        stream,
        reasoning: { effort: "high" },
      }));
      expect(response.status).toBe(200);
      await response.text();
      await diagnostics.close();
      expect(records.at(-1)).toMatchObject({
        reasoningEffort: "high",
        reasoningSummary: "missing",
      });
      if (reasoningTokens === undefined) expect(records.at(-1)).not.toHaveProperty("reasoningTokens");
      else expect(records.at(-1)?.reasoningTokens).toBe(reasoningTokens);
      expect(JSON.stringify(records)).not.toContain("PRIVATE");
    } finally {
      await harness.close();
      await diagnostics.close();
    }
  });

  it("round-trips Responses opaque reasoning through Chat and fails a cross-model carrier before inference", async () => {
    const harness = await matrixGateway(true, undefined, { responsesToolResponse: true });
    try {
      const first = await harness.gw.fetch(jsonRequest("/v1/chat/completions", {
        model: "native-responses",
        messages: [{ role: "user", content: "render" }],
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
      }));
      expect(first.status).toBe(200);
      const message = ((await first.json()) as {
        choices: Array<{ message: { reasoning_items?: Array<Record<string, unknown>>; tool_calls?: Array<{ id: string }> } }>;
      }).choices[0]?.message;
      const token = message?.reasoning_items?.[0]?.encrypted_content;
      expect(token).toEqual(expect.stringMatching(/^ghcg-rsn-v1:responses_item:chat:/u));

      const before = harness.upstream.requests.length;
      const rejected = await harness.gw.fetch(jsonRequest("/v1/chat/completions", {
        model: "native-chat",
        messages: [{
          role: "assistant",
          content: null,
          reasoning_items: message?.reasoning_items,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{}" },
          }],
        }, {
          role: "tool",
          tool_call_id: "call_1",
          content: "ok",
        }],
      }));
      expect(rejected.status).toBe(400);
      expect(harness.upstream.requests).toHaveLength(before);
    } finally {
      await harness.close();
    }
  });

  it("keeps native Responses priority for extended tools", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-responses",
        input: "render",
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      }));
      expect(response.status).toBe(200);
      expect(response.headers.get("x-ghcg-upstream-protocol")).toBe("responses");
      expect(harness.upstream.requests.map((entry) => [entry.path, JSON.parse(decoder.decode(entry.body)).stream === true])).toEqual([["/responses", false]]);
      expect(JSON.parse(decoder.decode(harness.responsesBodies[0]))).toMatchObject({
        tools: [{ type: "custom", name: "render" }],
      });
    } finally {
      await harness.close();
    }
  });

  it("uses candidate compatibility before fixed priority without probing or fallback", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/chat/completions", {
        model: "responses-messages",
        messages: [{ role: "user", content: "hi" }],
        stop: ["END"],
      }));
      expect(response.status).toBe(200);
      await response.text();
      expect(harness.upstream.requests.map((entry) => [entry.path, JSON.parse(decoder.decode(entry.body)).stream === true])).toEqual([["/v1/messages", false]]);
      expect(JSON.parse(decoder.decode(harness.messagesBodies[0]))).toMatchObject({
        model: "responses-messages",
        stop_sequences: ["END"],
      });

    } finally {
      await harness.close();
    }
  });

  it.each([
    ["/v1/chat/completions", {
      model: "native-messages",
      messages: [{ role: "user", content: "hi" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          description: "Return the amount in EUR, not USD.",
          schema: { type: "object" },
          strict: true,
        },
      },
    }],
    ["/v1/responses", {
      model: "native-messages",
      input: "hi",
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          description: "Return the amount in EUR, not USD.",
          schema: { type: "object" },
          strict: true,
        },
      },
    }],
  ] as const)("rejects unrepresentable Messages output descriptions before inference on %s", async (path, request) => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest(path, request));
      expect(response.status).toBe(422);
      await response.text();
      expect(harness.upstream.requests).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it.each([
    [{
      tools: [
        { type: "custom", name: "render", description: 17, format: 17 },
        { type: "function", name: "bad", description: 17, parameters: [], unknown: true },
      ],
    }, 200],
    [{
      tools: [{
        type: "namespace",
        name: "ns",
        tools: [{
          type: "function",
          name: "bad",
          parameters: "invalid",
          strict: "invalid",
          unknown_constraint: true,
        }],
      }],
    }, 200],
    [{
      tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      tool_choice: { type: "custom", name: "missing" },
    }, 400],
  ] as const)("applies extended-tool tolerance and binding validation", async (extra, status) => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "render",
        ...extra,
      }));
      expect(response.status).toBe(status);
      await response.text();
      expect(harness.upstream.requests).toHaveLength(status === 200 ? 1 : 0);
    } finally {
      await harness.close();
    }
  });

  it("omits a malformed optional extended-tool parallel control", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "render",
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
        parallel_tool_calls: "bad",
      }));
      expect(response.status).toBe(200);
      expect(harness.upstream.requests).toHaveLength(1);
      expect(JSON.parse(decoder.decode(harness.chatBodies[0]))).not.toHaveProperty("parallel_tool_calls");
    } finally {
      await harness.close();
    }
  });

  it("keeps the first duplicate field in flat namespace children", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(rawRequest(
        "/v1/responses",
        "{\"model\":\"native-chat\",\"input\":\"render\",\"tools\":[{\"type\":\"namespace\",\"name\":\"ns\",\"tools\":[{\"type\":\"function\",\"name\":\"lookup\",\"parameters\":{\"type\":\"object\"},\"strict\":false,\"strict\":true}]}]}",
      ));
      expect(response.status).toBe(200);
      await response.text();
      expect(harness.upstream.requests).toHaveLength(1);
      expect(JSON.parse(decoder.decode(harness.chatBodies[0]))).toMatchObject({
        tools: [{ function: { strict: false } }],
      });
    } finally {
      await harness.close();
    }
  });

  it("keeps the first duplicate field in discovered namespaces", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(rawRequest(
        "/v1/responses",
        "{\"model\":\"native-chat\",\"input\":[{\"type\":\"tool_search_call\",\"call_id\":\"call_search\",\"arguments\":{\"query\":\"lookup\"}},{\"type\":\"tool_search_output\",\"call_id\":\"call_search\",\"tools\":[{\"type\":\"namespace\",\"name\":\"first\",\"name\":\"second\",\"tools\":[{\"type\":\"function\",\"name\":\"lookup\",\"parameters\":{\"type\":\"object\"}}]}]}],\"tools\":[{\"type\":\"tool_search\"}]}",
      ));
      expect(response.status).toBe(200);
      await response.text();
      expect(harness.upstream.requests).toHaveLength(1);
      expect(decoder.decode(harness.chatBodies[0])).toContain("first__lookup");
      expect(decoder.decode(harness.chatBodies[0])).not.toContain("second__lookup");
    } finally {
      await harness.close();
    }
  });

  it("round-trips a buffered custom tool through scoped Responses history", async () => {
    const harness = await matrixGateway();
    try {
      const first = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "render",
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      }));
      const firstBody = await first.json() as {
        id: string;
        output: Array<{ type: string; call_id?: string }>;
      };
      const call = firstBody.output.find((item) => item.type === "custom_tool_call");
      expect(call?.call_id).toBe("call_custom");
      const second = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        previous_response_id: firstBody.id,
        input: [{
          type: "custom_tool_call_output",
          call_id: "call_custom",
          output: "done",
        }],
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      }));
      expect(second.status).toBe(200);
      expect(await second.text()).toContain("ok");
      expect(harness.upstream.requests.map((entry) => [entry.path, JSON.parse(decoder.decode(entry.body)).stream === true])).toEqual([["/chat/completions", false], ["/chat/completions", false]]);
    } finally {
      await harness.close();
    }
  });

  it("continues an ordinary function call declared alongside an extended tool", async () => {
    const harness = await matrixGateway();
    try {
      const tools = [
        {
          type: "function",
          name: "lookup",
          parameters: { type: "object" },
          strict: false,
        },
        { type: "custom", name: "render", format: { type: "text" } },
      ];
      const first = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "ordinary-mixed",
        tools,
      }));
      expect(first.status).toBe(200);
      const firstBody = await first.json() as {
        id: string;
        output: Array<{ type: string; call_id?: string; name?: string }>;
      };
      expect(firstBody.output).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "function_call", call_id: "call_ordinary", name: "lookup" }),
      ]));

      const second = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        previous_response_id: firstBody.id,
        input: [{
          type: "function_call_output",
          call_id: "call_ordinary",
          output: "done",
        }],
        tools,
      }));
      expect(second.status).toBe(200);
      expect(harness.upstream.requests.map((entry) => [entry.path, JSON.parse(decoder.decode(entry.body)).stream === true])).toEqual([["/chat/completions", false], ["/chat/completions", false]]);
    } finally {
      await harness.close();
    }
  });

  it("preserves compatible Responses function strict defaults on the extended Chat route", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "render",
        tools: [
          {
            type: "function",
            name: "strict_lookup",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
          {
            type: "namespace",
            name: "ns",
            tools: [{
              type: "function",
              name: "nested_strict_lookup",
              parameters: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
              strict: true,
            }],
          },
          { type: "custom", name: "render", format: { type: "text" } },
        ],
      }));
      expect(response.status).toBe(200);
      await response.text();
      const request = JSON.parse(decoder.decode(harness.chatBodies[0])) as {
        tools: Array<{ function: { name: string; strict?: boolean } }>;
      };
      expect(request.tools.find((tool) => tool.function.name === "strict_lookup")?.function.strict).toBe(true);
      expect(request.tools.find((tool) => tool.function.name !== "strict_lookup"
        && tool.function.name !== "render")?.function.strict).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("preserves omitted strict on the extended Chat route", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "render",
        tools: [
          {
            type: "function",
            name: "ambiguous",
            parameters: {
              type: "object",
              properties: { optional_value: { type: "string" } },
            },
          },
          { type: "custom", name: "render", format: { type: "text" } },
        ],
      }));
      expect(response.status).toBe(200);
      const request = JSON.parse(decoder.decode(harness.chatBodies[0])) as {
        tools: Array<{ function: { name: string; strict?: boolean } }>;
      };
      expect(request.tools.find((tool) => tool.function.name === "ambiguous")?.function).not.toHaveProperty("strict");
      expect(harness.upstream.requests.map((entry) => [entry.path, JSON.parse(decoder.decode(entry.body)).stream === true])).toEqual([["/chat/completions", false]]);
    } finally {
      await harness.close();
    }
  });

  it.each([
    ["none", "none"],
    ["max", "max"],
  ] as const)("uses normalized Responses reasoning effort %s on the extended Chat route", async (source, expected) => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "render",
        reasoning: { effort: source },
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      }));
      expect(response.status).toBe(200);
      const request = JSON.parse(decoder.decode(harness.chatBodies[0])) as { reasoning_effort?: string };
      expect(request.reasoning_effort).toBe(expected);
    } finally {
      await harness.close();
    }
  });

  it("round-trips a buffered namespace tool and preserves incomplete item status", async () => {
    const harness = await matrixGateway();
    try {
      const first = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "namespace",
        tools: [{
          type: "namespace",
          name: "ns",
          tools: [{
            type: "function",
            name: "lookup",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          }],
        }],
      }));
      const firstBody = await first.json() as {
        id: string;
        output: Array<{ type: string; call_id?: string; namespace?: string }>;
      };
      const call = firstBody.output.find((item) => item.type === "function_call");
      expect(call).toMatchObject({ call_id: "call_namespace", namespace: "ns" });
      const second = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        previous_response_id: firstBody.id,
        input: [{
          type: "function_call_output",
          call_id: "call_namespace",
          output: "failed",
          status: "failed",
        }],
        tools: [{
          type: "namespace",
          name: "ns",
          tools: [{
            type: "function",
            name: "lookup",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          }],
        }],
      }));
      expect(second.status).toBe(200);
      expect(decoder.decode(harness.chatBodies[1])).toContain("[ghc-gateway:tool-result-error]");

      const incomplete = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "partial-custom",
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      }));
      expect(await incomplete.json()).toMatchObject({
        status: "incomplete",
        output: expect.arrayContaining([
          expect.objectContaining({ type: "custom_tool_call", status: "incomplete" }),
        ]),
      });
    } finally {
      await harness.close();
    }
  });

  it.each([
    {
      input: "collision",
      tools: [
        { type: "function", name: "ns__lookup", parameters: { type: "object" } },
        {
          type: "namespace",
          name: "ns",
          tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
        },
      ],
    },
    {
      input: [{ type: "tool_search_call", call_id: "call_search" }],
      tools: [{ type: "tool_search" }],
    },
    {
      input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "unsafe" }] }],
      tools: [{ type: "custom", name: "render", format: { type: "text" } }],
    },
    {
      input: { role: "developer", content: [{ type: "input_text", text: "unsafe" }] },
      tools: [{ type: "custom", name: "render", format: { type: "text" } }],
    },
    {
      input: [
        { role: "user", content: [{ type: "input_text", text: "first" }] },
        { role: "system", content: [{ type: "input_text", text: "late" }] },
      ],
      tools: [{ type: "custom", name: "render", format: { type: "text" } }],
    },
    {
      input: "namespace choice",
      tools: [{
        type: "namespace",
        name: "ns",
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      }],
      tool_choice: { type: "function", namespace: "missing", name: "lookup" },
    },
    {
      input: [
        { type: "custom_tool_call", call_id: "call_dup", name: "render", input: "x" },
        { type: "function_call", call_id: "call_dup", name: "lookup", arguments: "{}" },
      ],
      tools: [
        { type: "custom", name: "render", format: { type: "text" } },
        { type: "function", name: "lookup", parameters: { type: "object" } },
      ],
    },
    {
      input: [
        { type: "custom_tool_call", call_id: "call_1", name: "render", input: "x" },
        { role: "user", content: [{ type: "input_text", text: "interrupt" }] },
        { type: "custom_tool_call_output", call_id: "call_1", output: "done" },
      ],
      tools: [{ type: "custom", name: "render", format: { type: "text" } }],
    },
  ])("rejects lossy extended tool variants before inference", async (request) => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        ...request,
      }));
      expect([400, 422]).toContain(response.status);
      await response.text();
      expect(harness.upstream.requests).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("omits unsupported optional formats on discovered custom tools", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: [
          { type: "tool_search_call", call_id: "call_search", arguments: { query: "x" } },
          {
            type: "tool_search_output",
            call_id: "call_search",
            tools: [{ type: "custom", name: "grammar", format: { type: "grammar", syntax: "regex" } }],
          },
        ],
        tools: [{ type: "tool_search" }],
      }));
      expect(response.status).toBe(200);
      await response.text();
      expect(harness.upstream.requests).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("preserves tool-search discovery declarations in a buffered round trip", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: [
          {
            type: "tool_search_call",
            call_id: "call_search",
            arguments: { query: "lookup" },
          },
          {
            type: "tool_search_output",
            call_id: "call_search",
            tools: [{
              type: "function",
              name: "lookup",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            }],
          },
          {
            type: "function_call",
            call_id: "call_lookup",
            name: "lookup",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_lookup",
            output: "done",
          },
        ],
        tools: [{ type: "tool_search" }],
      }));
      expect(response.status).toBe(200);
      expect(harness.upstream.requests.map((entry) => [entry.path, JSON.parse(decoder.decode(entry.body)).stream === true])).toEqual([["/chat/completions", false]]);
    } finally {
      await harness.close();
    }
  });

  it("rejects extended tool-result media instead of dropping long adjacent text", async () => {
    const harness = await matrixGateway();
    try {
      const longText = "x".repeat(9000);
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: [
          { type: "custom_tool_call", call_id: "call_1", name: "render", input: "x" },
          {
            type: "custom_tool_call_output",
            call_id: "call_1",
            output: [
              { type: "input_text", text: longText },
              { type: "input_image", image_url: "data:image/png;base64,QUJD" },
            ],
          },
        ],
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      }));
      expect(response.status).toBe(422);
      await response.text();
      expect(harness.upstream.requests).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("rejects JSON-encoded extended result media before inference", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: [
          { type: "custom_tool_call", call_id: "call_1", name: "render", input: "x" },
          {
            type: "custom_tool_call_output",
            call_id: "call_1",
            output: JSON.stringify({
              content: [{ type: "input_image", image_url: "data:image/png;base64,QUJD" }],
            }),
          },
        ],
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
      }));
      expect(response.status).toBe(422);
      await response.text();
      expect(harness.upstream.requests).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it.each([
    ["chat", "native-chat", "chat-stream", "[DONE]"],
    ["chat", "native-messages", "messages-stream", "[DONE]"],
    ["chat", "native-responses", "responses-stream", "[DONE]"],
    ["messages", "native-chat", "chat-stream", "event: message_stop"],
    ["messages", "native-messages", "messages-stream", "event: message_stop"],
    ["messages", "native-responses", "responses-stream", "event: message_stop"],
    ["responses", "native-chat", "chat-stream", "response.completed"],
    ["responses", "native-messages", "messages-stream", "response.completed"],
    ["responses", "native-responses", "responses-stream", "response.completed"],
  ] as const)(
    "streams %s through %s with one operation and an exact success terminal",
    async (source, modelId, expectedKind, terminal) => {
      const harness = await matrixGateway();
      try {
        const response = await harness.gw.fetch(protocolRequest(source, modelId, { stream: true }));
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain("ok");
        expect(text).toContain(terminal);
        expect(harness.upstream.requests.map((entry) => [entry.path, JSON.parse(decoder.decode(entry.body)).stream === true])).toEqual([[{ chat: "/chat/completions", messages: "/v1/messages", responses: "/responses" }[expectedKind.replace("-stream", "") as "chat" | "messages" | "responses"], expectedKind.endsWith("-stream")]]);
        if (source === "chat") {
          expect(text.match(/data: \[DONE\]/gu)).toHaveLength(1);
        } else if (source === "messages") {
          expect(text).not.toContain("[DONE]");
          expect(text.match(/event: message_stop/gu)).toHaveLength(1);
        } else {
          expect(text).not.toContain("[DONE]");
          expect(text.match(/event: response\.completed/gu)).toHaveLength(1);
        }
      } finally {
        await harness.close();
      }
    },
  );

  it.each([
    ["/v1/chat/completions", "{\"model\":\"native-responses\",\"messages\":[],\"n\":2}", 422],
    ["/v1/messages", "{\"model\":\"native-responses\",\"max_tokens\":8,\"messages\":[],\"stop_sequences\":[\"x\"]}", 400],
    ["/v1/responses", "{\"model\":\"native-messages\",\"input\":\"hi\",\"background\":true}", 422],
  ] as const)("rejects converted request %s before inference", async (path, body, status) => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(rawRequest(path, body));
      expect(response.status).toBe(status);
      await response.text();
      expect(harness.upstream.requests).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("omits an unknown converted Responses reasoning effort", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(rawRequest(
        "/v1/responses",
        "{\"model\":\"native-chat\",\"input\":\"hi\",\"reasoning\":{\"effort\":\"ultra\"}}",
      ));
      expect(response.status).toBe(200);
      await response.text();
      expect(harness.upstream.requests).toHaveLength(1);
      expect(decoder.decode(harness.upstream.requests[0]?.body)).not.toContain("ultra");
    } finally {
      await harness.close();
    }
  });

  it("omits an ordinary converted Chat extension while keeping native projection separate", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(rawRequest(
        "/v1/chat/completions",
        "{\"model\":\"responses-messages\",\"messages\":[],\"unknown\":null}",
      ));
      expect(response.status).toBe(200);
      await response.text();
      expect(harness.upstream.requests).toHaveLength(1);
      expect(decoder.decode(harness.upstream.requests[0]?.body)).not.toContain("unknown");
    } finally {
      await harness.close();
    }
  });

  it("uses the first duplicate routing control on every converted endpoint", async () => {
    const harness = await matrixGateway();
    try {
      const requests = [
        ["chat", rawRequest(
          "/v1/chat/completions",
          "{\"model\":\"responses-messages\",\"model\":\"missing\",\"stream\":false,\"stream\":true,\"messages\":[]}",
        )],
        ["messages", rawRequest(
          "/v1/messages",
          "{\"model\":\"native-chat\",\"model\":\"missing\",\"stream\":false,\"stream\":true,\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}",
        )],
        ["responses", rawRequest(
          "/v1/responses",
          "{\"model\":\"native-chat\",\"model\":\"missing\",\"stream\":false,\"stream\":true,\"input\":\"hi\"}",
        )],
      ] as const;
      for (const [protocol, request] of requests) {
        expect((await harness.gw.fetch(request)).status, protocol).toBe(200);
      }
      expect(harness.upstream.requests).toHaveLength(3);
      for (const request of harness.upstream.requests) {
        expect(JSON.parse(decoder.decode(request.body)).stream).not.toBe(true);
      }

    } finally {
      await harness.close();
    }
  });

  it.each(["max", "ultra"] as const)("preserves %s reasoning and unknown extensions on all native paths", async (effort) => {
    const harness = await matrixGateway();
    try {
      const requests = [
        protocolRequest("chat", "native-chat", { native_extension: { z: 1 }, reasoning_effort: effort }),
        protocolRequest("messages", "native-messages", { native_extension: { z: 2 }, output_config: { effort } }),
        protocolRequest("responses", "native-responses", { native_extension: { z: 3 }, reasoning: { effort } }),
      ];
      for (const request of requests) {
        expect((await harness.gw.fetch(request)).status).toBe(200);
      }
      expect(JSON.parse(decoder.decode(harness.chatBodies[0]))).toMatchObject({
        native_extension: { z: 1 },
        reasoning_effort: effort,
      });
      expect(JSON.parse(decoder.decode(harness.messagesBodies[0]))).toMatchObject({
        native_extension: { z: 2 },
        output_config: { effort },
      });
      expect(JSON.parse(decoder.decode(harness.responsesBodies[0]))).toMatchObject({
        native_extension: { z: 3 },
        reasoning: { effort },
      });
    } finally {
      await harness.close();
    }
  });

  it("forwards native Messages beta tokens exactly in client order, including duplicates and unknown values", async () => {
    const harness = await matrixGateway();
    try {
      const request = protocolRequest("messages", "native-messages", { native_extension: { z: 2 } });
      request.headers.set(
        "anthropic-beta",
        "unknown-first-2026-01-01,claude-code-20250219,unknown-first-2026-01-01,prompt-caching-2024-07-31",
      );
      const response = await harness.gw.fetch(request);
      expect(response.status).toBe(200);
      await response.text();
      expect(harness.upstream.requests).toHaveLength(1);
      expect(harness.upstream.requests[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
      expect(harness.upstream.requests[0]?.headers.get("anthropic-beta")).toBe(
        "unknown-first-2026-01-01,claude-code-20250219,unknown-first-2026-01-01,prompt-caching-2024-07-31",
      );
    } finally {
      await harness.close();
    }
  });

  it("keeps a reasoning carrier from another response in place and still sends the continuation", async () => {
    const chatBody = encoder.encode(JSON.stringify({
      id: "chatcmpl_tool",
      object: "chat.completion",
      created: 1_700_000_000,
      model: "matrix",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          reasoning_content: "visible plan",
          reasoning_opaque: "provider-state",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }));
    const records: DiagnosticRecord[] = [];
    const diagnostics = new DiagnosticRecorder({ write: (record) => records.push(record) }, {
      nowMs: () => 100, monotonicNowMs: () => 10,
    });
    const harness = await matrixGateway(true, diagnostics, { chatBody });
    try {
      const tools = [{ type: "function", name: "lookup", parameters: { type: "object" }, strict: false }];
      const turn = async (input: string) => await (await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat", input, tools,
      }))).json() as { id: string; output: Array<Record<string, unknown>> };
      const first = await turn("first");
      const other = await turn("other");
      const otherReasoning = other.output.find((item) => item.type === "reasoning");
      expect(otherReasoning?.encrypted_content).toEqual(expect.stringMatching(/^ghcg-rsn-v1:/u));

      // The other response's carrier is not in the referenced checkpoint; it stays where the client
      // put it, the referenced response's calls are restored, and the request reaches the upstream.
      const continued = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        previous_response_id: first.id,
        input: [otherReasoning, { type: "function_call_output", call_id: "call_1", output: "ok" }],
        tools,
      }));
      const continuedBody = await continued.text();
      await diagnostics.close();
      expect(continued.status, `${continuedBody} ${JSON.stringify(records.filter((record) => record.event === "request_failed"))}`).toBe(200);
      expect(harness.upstream.requests.map((entry) => entry.path)).toEqual([
        "/chat/completions", "/chat/completions", "/chat/completions",
      ]);
      const forwarded = decoder.decode(harness.chatBodies.at(-1));
      expect(forwarded).not.toContain("previous_response_id");
      expect(forwarded).toContain("\"tool_call_id\":\"call_1\"");
    } finally {
      await harness.close();
    }
  });

  it("pins a Responses continuation to Messages and consumes previous_response_id locally", async () => {
    const harness = await matrixGateway();
    try {
      await harness.history.recordCheckpoint({
        responseId: "resp_messages_owned",
        output: [{
          kind: "object",
          members: [
            { key: "type", value: "function_call" },
            { key: "id", value: "fc_owned" },
            { key: "call_id", value: "call_owned" },
            { key: "name", value: "lookup" },
            { key: "arguments", value: "{\"q\":\"x\"}" },
          ],
        }],
      }, {
        accountId: "github.com/1",
        modelId: "dual-messages",
        upstreamOrigin: harness.upstream.origin,
        owner: "converted",
        upstreamProtocol: "messages",
        conversionVersion: "responses-messages-v1",
      }, "complete", new AbortController().signal);

      const resultOnly = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "dual-messages",
        previous_response_id: "resp_messages_owned",
        input: [{
          type: "function_call_output",
          call_id: "call_owned",
          output: "result",
        }],
      }));
      expect(resultOnly.status).toBe(200);
      expect((await resultOnly.json() as { previous_response_id: string | null }).previous_response_id)
        .toBe("resp_messages_owned");
      const resultOnlyBody = JSON.parse(decoder.decode(harness.messagesBodies[0])) as {
        messages: Array<Record<string, unknown>>;
      };
      expect(resultOnlyBody.messages[0]).toEqual({
        role: "user",
        content: [{ type: "text", text: "(continuing the conversation)" }],
      });

      for (const content of ["", [], [{ type: "input_text", text: "" }]]) {
        const emptyContext = await harness.gw.fetch(jsonRequest("/v1/responses", {
          model: "dual-messages",
          previous_response_id: "resp_messages_owned",
          input: [
            { type: "message", role: "user", content },
            {
              type: "function_call_output",
              call_id: "call_owned",
              output: "result",
            },
          ],
        }));
        expect(emptyContext.status).toBe(200);
        await emptyContext.text();
      }

      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "dual-messages",
        previous_response_id: "resp_messages_owned",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Use the tool result for the original task." }],
          },
          {
            type: "function_call_output",
            call_id: "call_owned",
            output: "result",
          },
        ],
      }));
      expect(response.status).toBe(200);
      expect((await response.json() as { previous_response_id: string | null }).previous_response_id)
        .toBe("resp_messages_owned");
      expect(harness.upstream.requests).toHaveLength(5);
      expect(harness.upstream.requests.every((entry) => (
        entry.path === "/v1/messages" && JSON.parse(decoder.decode(entry.body)).stream !== true
      ))).toBe(true);
      const forwarded = decoder.decode(harness.messagesBodies.at(-1));
      expect(forwarded).not.toContain("previous_response_id");
      expect(forwarded).toContain("call_owned");
      expect(forwarded).toContain("original task");
    } finally {
      await harness.close();
    }
  });

  it("keeps the existing Responses-to-Chat custom tool adapter connected", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "render",
        max_completion_tokens: 7,
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
        tool_choice: { type: "custom", name: "render" },
      }));
      expect(response.status).toBe(200);
      const payload = await response.json() as { output?: unknown[] };
      expect(payload.output).toEqual(expect.arrayContaining([expect.objectContaining({
        type: "custom_tool_call",
        call_id: "call_custom",
        name: "render",
        input: "hello",
      })]));
      expect(JSON.parse(decoder.decode(harness.chatBodies[0]))).toMatchObject({ max_tokens: 7 });
      expect(decoder.decode(harness.chatBodies[0])).not.toContain("max_completion_tokens");
      expect(harness.upstream.requests.map((entry) => [entry.path, JSON.parse(decoder.decode(entry.body)).stream === true])).toEqual([["/chat/completions", false]]);
    } finally {
      await harness.close();
    }
  });

  it.each([
    [{ text: { format: { type: "json_schema", name: "x", schema: { type: "object" } } } }, 422],
    [{ stream: true }, 422],
  ] as const)("rejects unsafe extended-tool semantics before inference", async (extra, status) => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "render",
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
        ...extra,
      }));
      expect(response.status).toBe(status);
      await response.text();
      expect(harness.upstream.requests).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("omits an invalid optional output limit for extended tools", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/responses", {
        model: "native-chat",
        input: "render",
        tools: [{ type: "custom", name: "render", format: { type: "text" } }],
        max_output_tokens: -1,
      }));
      expect(response.status).toBe(200);
      expect(harness.upstream.requests).toHaveLength(1);
      expect(JSON.parse(decoder.decode(harness.chatBodies[0]))).not.toHaveProperty("max_tokens");
    } finally {
      await harness.close();
    }
  });
});

interface MatrixHarness {
  readonly gw: Gateway;
  readonly upstream: CopilotHttpMock;
  readonly history: SqliteResponsesHistory;
  readonly reasoningCarriers: ReasoningCarrierStore;
  readonly chatBodies: Uint8Array[];
  readonly messagesBodies: Uint8Array[];
  readonly responsesBodies: Uint8Array[];
  close(): Promise<void>;
}

async function matrixGateway(
  reasoning = false,
  diagnostics?: DiagnosticRecorder,
  overrides: {
    readonly chatBody?: Uint8Array;
    readonly messagesBody?: Uint8Array;
    readonly responsesBody?: Uint8Array;
    readonly chatStreamBody?: Uint8Array;
    readonly responsesStreamBody?: Uint8Array;
    readonly responsesStreamContentType?: string;
    readonly responsesToolResponse?: boolean;
  } = {},
): Promise<MatrixHarness> {
  return await withSetupCleanup(async (own) => {
    const database = openDatabase({
      path: ":memory:",
      migrations: [
        embedMigration(runtimeConfigMigration),
        embedMigration(accountsMigration),
        embedMigration(responsesHistoryMigration),
        embedMigration(responsesContinuationMigration),
        embedMigration(reasoningCarriersMigration),
      ],
      nowMs,
    });
    own(() => closeDatabase(database));
    const credentials = new MemoryCredentialStore();
    const accountCoordinator = new AccountCoordinator();
    const directory = new AccountDirectory(database, credentials, accountCoordinator, nowMs);
    await directory.upsertAuthenticated({
      host: "github.com",
      userId: "1",
      secret: { generation: 0, githubToken: "test-token" },
    });
    const catalog = new CopilotModelCatalog({
      async fetch() {
        return {
          data: [
            model("native-chat", ["/v1/chat/completions"]),
            model("native-messages", ["/v1/messages"]),
            model("native-responses", ["/v1/responses"]),
            model("responses-messages", ["/v1/responses", "/v1/messages"]),
            model("dual-messages", ["/v1/responses", "/v1/messages"]),
          ],
        };
      },
    }, () => new Date(nowMs()));
    const history = new SqliteResponsesHistory(database, { nowMs });
    let carrierUuid = 0;
    const reasoningCarriers = new SqliteReasoningCarrierStore(database, {
      nowMs,
      createId: () => `00000000-0000-4000-8000-${(++carrierUuid).toString().padStart(12, "0")}`,
    });
    const responseReasoning = {
      id: "rs_matrix_stream",
      type: "reasoning",
      status: "completed",
      summary: [],
      content: [{ type: "reasoning_text", text: "visible plan" }],
      encrypted_content: "provider-state",
    };
    const response = {
      id: "resp_matrix_stream",
      object: "response",
      created_at: 1_700_000_000,
      status: "completed",
      output: [...(reasoning ? [responseReasoning] : []), {
        id: "msg_matrix_stream",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    };
    const toolResponse = {
      ...response,
      output: [...(reasoning ? [responseReasoning] : []), {
        id: "fc_matrix",
        type: "function_call",
        call_id: "call_1",
        name: "lookup",
        arguments: "{}",
        status: "completed",
      }],
    };
    const http = await startHttpCopilot({
      credentials, accountCoordinator, nowMs,
      expectations: [
        {
          method: "POST", path: "/chat/completions", body: jsonStream(false), times: 8,
          reply: {
            headers: { "content-type": "application/json" }, stream: async (exchange) => {
              await exchange.end(overrides.chatBody ?? matrixChatResponse(exchange.request.body, reasoning));
            }
          }
        },
        {
          method: "POST", path: "/v1/messages", body: jsonStream(false), times: 8,
          reply: {
            status: 200,
            headers: {},
            body: overrides.messagesBody ?? encoder.encode(JSON.stringify({
              id: "msg_matrix",
              type: "message",
              role: "assistant",
              model: "matrix",
              content: [
                ...(reasoning ? [{ type: "thinking", thinking: "visible plan", signature: "provider-signature" }] : []),
                { type: "text", text: "ok" },
              ],
              stop_reason: "end_turn",
              stop_sequence: null,
              usage: { input_tokens: 2, output_tokens: 1 },
            })),
          }
        },
        {
          method: "POST", path: "/responses", body: jsonStream(false), times: 8,
          reply: {
            status: 200,
            headers: {},
            body: overrides.responsesBody ?? encoder.encode(JSON.stringify(
              overrides.responsesToolResponse === true ? toolResponse : response,
            )),
          }
        },
        {
          method: "POST", path: "/chat/completions", body: jsonStream(true), times: 8,
          reply: {
            headers: { "content-type": "text/event-stream" }, body: overrides.chatStreamBody ?? Buffer.concat([
              ...(reasoning ? [encoder.encode(`data: ${JSON.stringify({
                id: "chatcmpl_matrix_stream",
                object: "chat.completion.chunk",
                created: 1_700_000_000,
                model: "matrix",
                choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "visible plan" }, finish_reason: null }],
              })}\n\n`)] : []),
              encoder.encode(`data: ${JSON.stringify({
                id: "chatcmpl_matrix_stream",
                object: "chat.completion.chunk",
                created: 1_700_000_000,
                model: "matrix",
                choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
              })}\n\n`),
              encoder.encode("data: [DONE]\n\n"),
            ])
          }
        },
        {
          method: "POST", path: "/v1/messages", body: jsonStream(true), times: 8,
          reply: {
            headers: { "content-type": "text/event-stream" }, body: Buffer.concat([
              messagesEvent("message_start", {
                type: "message_start",
                message: {
                  id: "msg_matrix_stream",
                  type: "message",
                  role: "assistant",
                  content: [],
                  model: "matrix",
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 2, output_tokens: 0 },
                },
              }),
              ...(reasoning ? [
                messagesEvent("content_block_start", {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "thinking", thinking: "", signature: "" },
                }),
                messagesEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "thinking_delta", thinking: "visible plan" },
                }),
                messagesEvent("content_block_delta", {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "signature_delta", signature: "provider-signature" },
                }),
                messagesEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
              ] : []),
              messagesEvent("content_block_start", {
                type: "content_block_start",
                index: reasoning ? 1 : 0,
                content_block: { type: "text", text: "" },
              }),
              messagesEvent("content_block_delta", {
                type: "content_block_delta",
                index: reasoning ? 1 : 0,
                delta: { type: "text_delta", text: "ok" },
              }),
              messagesEvent("content_block_stop", { type: "content_block_stop", index: reasoning ? 1 : 0 }),
              messagesEvent("message_delta", {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 1 },
              }),
              messagesEvent("message_stop", { type: "message_stop" }),
            ])
          }
        },
        {
          method: "POST", path: "/responses", body: jsonStream(true), times: 8,
          reply: {
            headers: { "content-type": overrides.responsesStreamContentType ?? "text/event-stream" },
            body: overrides.responsesStreamBody ?? Buffer.concat([
              responsesEvent(0, "response.created", { response: { ...response, status: "in_progress", output: [] } }),
              ...(reasoning ? [
                responsesEvent(1, "response.output_item.added", {
                  output_index: 0,
                  item: { ...responseReasoning, status: "in_progress", content: [] },
                }),
                responsesEvent(2, "response.reasoning_text.delta", {
                  item_id: "rs_matrix_stream", output_index: 0, content_index: 0, delta: "visible plan",
                }),
                responsesEvent(3, "response.reasoning_text.done", {
                  item_id: "rs_matrix_stream", output_index: 0, content_index: 0, text: "visible plan",
                }),
                responsesEvent(4, "response.output_item.done", { output_index: 0, item: responseReasoning }),
              ] : []),
              responsesEvent(reasoning ? 5 : 1, "response.output_item.added", {
                output_index: reasoning ? 1 : 0,
                item: { ...response.output[reasoning ? 1 : 0], status: "in_progress", content: [] },
              }),
              responsesEvent(reasoning ? 6 : 2, "response.output_text.delta", {
                item_id: "msg_matrix_stream",
                output_index: reasoning ? 1 : 0,
                content_index: 0,
                delta: "ok",
              }),
              responsesEvent(reasoning ? 7 : 3, "response.output_text.done", {
                item_id: "msg_matrix_stream",
                output_index: reasoning ? 1 : 0,
                content_index: 0,
                text: "ok",
              }),
              responsesEvent(reasoning ? 8 : 4, "response.output_item.done", {
                output_index: reasoning ? 1 : 0,
                item: response.output[reasoning ? 1 : 0],
              }),
              responsesEvent(reasoning ? 9 : 5, "response.completed", { response }),
            ])
          }
        }
      ],
    });
    own(() => http.close());
    const registry = testModelCapabilityRegistry(catalog);
    own(() => registry.close());
    const routeDependencies = {
      directory,
      registry,
      preferences: directory.preferences,
      copilot: http.backend,
      reasoningCarriers,
      createUuid: () => "00000000-0000-4000-8000-000000000104",
      nowMs,
    };
    const gw = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: "Q:\\ghc-gateway-tests\\matrix\\.home" }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, [
      createOpenaiChatCompletionsRoute(routeDependencies),
      createAnthropicMessagesRoute(routeDependencies),
      createOpenaiResponsesRoute({ ...routeDependencies, history, nowUnixSeconds: () => 1_700_000_000 }),
    ], { createRequestId: () => "req_matrix", ...(diagnostics === undefined ? {} : { diagnostics }) });
    own(() => gw.close());
    return {
      gw,
      upstream: http.upstream,
      history,
      reasoningCarriers,
      get chatBodies() { return http.upstream.requests.filter((request) => request.path === "/chat/completions").map((request) => request.body); },
      get messagesBodies() { return http.upstream.requests.filter((request) => request.path === "/v1/messages").map((request) => request.body); },
      get responsesBodies() { return http.upstream.requests.filter((request) => request.path === "/responses").map((request) => request.body); },
      async close() {
        await closeAll([() => gw.close(), () => registry.close(), () => http.close(), () => closeDatabase(database)]);
      },
    };
  });
}

function matrixChatResponse(raw: Uint8Array, reasoning = false): Uint8Array {
  const captured = JSON.parse(decoder.decode(raw)) as {
    messages?: Array<{ role?: string }>;
    tools?: Array<{ function?: { name?: string } }>;
  };
  const hasToolResult = captured.messages?.some((message) => message.role === "tool") === true;
  const custom = captured.tools?.some((tool) => tool.function?.name === "render") === true;
  const namespace = captured.tools?.some((tool) => tool.function?.name === "ns__lookup") === true;
  const ordinaryMixed = decoder.decode(raw).includes("ordinary-mixed");
  const partialCustom = decoder.decode(raw).includes("partial-custom");
  const toolCall = partialCustom
    ? {
      id: "call_custom",
      type: "function",
      function: { name: "render", arguments: "{\"input\":\"x\"" },
    }
    : ordinaryMixed
      ? {
        id: "call_ordinary",
        type: "function",
        function: { name: "lookup", arguments: "{}" },
      }
      : namespace
        ? {
          id: "call_namespace",
          type: "function",
          function: { name: "ns__lookup", arguments: "{}" },
        }
        : {
          id: "call_custom",
          type: "function",
          function: { name: "render", arguments: "{\"input\":\"hello\"}" },
        };
  return encoder.encode(JSON.stringify({
    id: "chatcmpl_matrix",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "matrix",
    choices: [{
      index: 0,
      message: (custom || namespace) && !hasToolResult
        ? {
          role: "assistant",
          content: null,
          tool_calls: [toolCall],
        }
        : {
          role: "assistant",
          ...(reasoning ? { reasoning_content: "visible plan", reasoning_opaque: "provider-state" } : {}),
          content: "ok",
        },
      finish_reason: partialCustom
        ? "length"
        : (custom || namespace) && !hasToolResult ? "tool_calls" : "stop",
    }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  }));
}

function model(id: string, supportedEndpoints: string[]) {
  return {
    id,
    name: id,
    vendor: "test",
    model_picker_enabled: true,
    model_info: {
      supported_endpoints: supportedEndpoints,
      max_output_tokens: 16_384,
      default_output_tokens: 4_096,
      chat_output_token_field: "max_tokens",
      supported_parameters: [
        "temperature",
        "top_p",
        "response_format",
        "text.format",
        "output_config.format",
        "reasoning_effort",
        "reasoning",
        "reasoning.effort",
        "output_config.effort",
      ],
      supported_reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    },
    capabilities: {
      supports: {
        reasoning_effort: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
        tool_calls: true,
        parallel_tool_calls: true,
        vision: true,
        tool_search: true,
      },
    },
  };
}

function protocolRequest(
  source: "chat" | "messages" | "responses",
  modelId: string,
  extra: Readonly<Record<string, unknown>> = {},
): Request {
  if (source === "chat") {
    return jsonRequest("/v1/chat/completions", {
      model: modelId,
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    });
  }
  if (source === "messages") {
    return jsonRequest("/v1/messages", {
      model: modelId,
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
      ...extra,
    });
  }
  return jsonRequest("/v1/responses", { model: modelId, input: "hi", ...extra });
}

function jsonRequest(path: string, body: unknown): Request {
  return rawRequest(path, JSON.stringify(body));
}

function rawRequest(path: string, body: string): Request {
  return new Request(`http://127.0.0.1:31400${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(path === "/v1/messages" ? { "anthropic-version": "2023-06-01" } : {}),
    },
    body,
  });
}

function messagesEvent(type: string, payload: Readonly<Record<string, unknown>>): Uint8Array {
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function responsesEvent(
  sequenceNumber: number,
  type: string,
  payload: Readonly<Record<string, unknown>>,
): Uint8Array {
  const event = { type, sequence_number: sequenceNumber, ...payload };
  return encoder.encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
}
