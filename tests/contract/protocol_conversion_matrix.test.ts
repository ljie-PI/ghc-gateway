import { createHash } from "node:crypto";
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

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("protocol conversion matrix", () => {
  it.each([
    ["chat", "chat", "native-chat", "chat", "4cd2995e268742a6cb8b64763c5e5c9638e4f161d1829e0ef836fcb42376a38f", "260fc9e378e94e51bc63602da0ff24783f47429817f11eb3b9075777a77bd3be"],
    ["chat", "messages", "native-messages", "messages", "9c73f197360c1da99f01cdf91ce6a4a7a4064df2742bf1256297e65e5373f0e2", "e2cffb760bb590d703faae2da778b5475cb5f1df375276fec7574faed3008f56"],
    ["chat", "responses", "native-responses", "responses", "434c745945784ad784b1ab523c460ecd1aca51e8006f71d51908abf1278f668a", "7d0c5797a9971b2e6030ea9642400af5b7a3ee1dc77c1aa154aca55db596349c"],
    ["messages", "chat", "native-chat", "chat", "f94fe833f1dc8d27d8ea6284b8b85adec4fbe64e77036102c798dc477d0433ec", "64d308fc9649f96b0c3c91a2b67b985534867fd36b540bf4954c8a4db0613e7c"],
    ["messages", "messages", "native-messages", "messages", "1a79e19d0fdc2470f74d006266b801e25c706e7c90a9fde19d927b03101e2dd1", "b705096dfb09b37f8a08350426983eac6179043447f7be34eb3d51fa7a1592e6"],
    ["messages", "responses", "native-responses", "responses", "af5f8eee76f5729795320e67af44b461fca90cd4cafde8ca4d6fe7cc011f570e", "d46b24ef1e351dda996ee73c7fecc834573353e4c384831daaf75bd22971c255"],
    ["responses", "chat", "native-chat", "chat", "4cd2995e268742a6cb8b64763c5e5c9638e4f161d1829e0ef836fcb42376a38f", "8f5ac691821257c0eba2951d2a592d2eaacece4b7394f77ae3a6caf09439f54b"],
    ["responses", "messages", "native-messages", "messages", "9c73f197360c1da99f01cdf91ce6a4a7a4064df2742bf1256297e65e5373f0e2", "4b040b0ae407c0851042b739a782ea9fe7a600fc87883b9873971ee5c152af15"],
    ["responses", "responses", "native-responses", "responses", "236b15d11611d828e675d2d917f0f3111e6a12fd5a2b2697373044439f6e7a76", "9687d02d50f62c51ebc2b2c2516132e0cb71b18a0b65cce48c8ce62da777574e"],
  ] as const)(
    "executes %s -> %s with one typed %s operation",
    async (source, _target, model, expectedKind, requestSha256, responseSha256) => {
      const harness = await matrixGateway();
      try {
        const response = await harness.gw.fetch(protocolRequest(source, model));
        expect(response.status).toBe(200);
        const responseText = await response.text();
        expect(responseText).toContain("ok");
        expect(capturedOperations(harness)).toEqual([expectedKind]);
        expect(sha256(harness.upstream.requests[0]!.body)).toBe(requestSha256);
        expect(sha256(responseText)).toBe(responseSha256);
      } finally {
        await harness.close();
      }
    },
  );

  it("uses candidate compatibility before fixed priority without probing or fallback", async () => {
    const harness = await matrixGateway();
    try {
      const response = await harness.gw.fetch(jsonRequest("/v1/chat/completions", {
        model: "responses-messages",
        messages: [{ role: "user", content: "hi" }],
        stop: ["END"],
      }));
      expect(response.status).toBe(200);
      expect(capturedOperations(harness)).toEqual(["messages"]);
      expect(JSON.parse(decoder.decode(harness.messagesBodies[0]))).toMatchObject({
        model: "responses-messages",
        stop_sequences: ["END"],
      });

    } finally {
      await harness.close();
    }
  });

  it.each([
    ["chat", "native-chat", "chat-stream", "[DONE]", "e3f466f55be31c94feddb9bb95c3fe88fb79a53c0ec158aa0b173e9f406aace9", "649ffe1d41f7c8534ff1f82e9b54be9f5e150bb5ee12ad696ed8f15bdb035f78"],
    ["chat", "native-messages", "messages-stream", "[DONE]", "7014ce488e0401aee305aa5bafcf11c97c45c0c335338d596bcc99794f0d153b", "adc09bdb90e6bad5c2ee0408b1a17308b69dd52daf30375dcaf2ffc32611344b"],
    ["chat", "native-responses", "responses-stream", "[DONE]", "46a5fedbfea63f3858304ee8ec8b3c224dd948a5c0684c5e34b28b16233365a0", "f2a447c46f199108ef56118009c23c81dab1384ed551e1bf75aab290af90903b"],
    ["messages", "native-chat", "chat-stream", "event: message_stop", "287e373e6e9204f33a1955646438453066cfc879edef55e779412ef780e180c6", "52085aa926ca768d9f018f0b0e87c6da10cfb27222a50430876c0b120441e497"],
    ["messages", "native-messages", "messages-stream", "event: message_stop", "f7e9293da60401c3ee820ffca4c1dd233d7f2913bf30a3ed90a4a76cce98e348", "af7160d2d400a33fbae6eaaa9bcdaab14d179763eb20b4dcc26aa8b7354a2a3c"],
    ["messages", "native-responses", "responses-stream", "event: message_stop", "7c2926fdcbc3b3792956f7c65c9b37e09b6b68840b6f7f454907d6fbf0613bfc", "999b761d0c9a2bb6e95a78bcf7b19ff580578c29f4d2b5018cdf666f18c39363"],
    ["responses", "native-chat", "chat-stream", "response.completed", "e3f466f55be31c94feddb9bb95c3fe88fb79a53c0ec158aa0b173e9f406aace9", "22239aacceb349de2313291a9c87f480c8c3068c3c9b87a63bf26cc63203be48"],
    ["responses", "native-messages", "messages-stream", "response.completed", "7014ce488e0401aee305aa5bafcf11c97c45c0c335338d596bcc99794f0d153b", "7d7f04b5cc4b9645848925ff4cb4e4fe46820117aa2e6b32080879b1b15766ad"],
    ["responses", "native-responses", "responses-stream", "response.completed", "5afca6ef1c11b84fe7c12b83144cb3ea73600d19b568e53a06b3dd71a6d03914", "9a4514e28782d2afa79f6412117d306adef25554c374232a15c601ff25120ff6"],
  ] as const)(
    "streams %s through %s with one operation and an exact success terminal",
    async (source, modelId, expectedKind, terminal, requestSha256, responseSha256) => {
      const harness = await matrixGateway();
      try {
        const response = await harness.gw.fetch(protocolRequest(source, modelId, { stream: true }));
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain("ok");
        expect(text).toContain(terminal);
        expect(capturedOperations(harness)).toEqual([expectedKind]);
        expect(sha256(harness.upstream.requests[0]!.body)).toBe(requestSha256);
        expect(sha256(text)).toBe(responseSha256);
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

  it("preserves unknown extensions on all native paths", async () => {
    const harness = await matrixGateway();
    try {
      const requests = [
        protocolRequest("chat", "native-chat", { native_extension: { z: 1 } }),
        protocolRequest("messages", "native-messages", { native_extension: { z: 2 } }),
        protocolRequest("responses", "native-responses", { native_extension: { z: 3 } }),
      ];
      for (const request of requests) {
        expect((await harness.gw.fetch(request)).status).toBe(200);
      }
      expect(JSON.parse(decoder.decode(harness.chatBodies[0]))).toMatchObject({
        native_extension: { z: 1 },
      });
      expect(JSON.parse(decoder.decode(harness.messagesBodies[0]))).toMatchObject({
        native_extension: { z: 2 },
      });
      expect(JSON.parse(decoder.decode(harness.responsesBodies[0]))).toMatchObject({
        native_extension: { z: 3 },
      });
    } finally {
      await harness.close();
    }
  });
});

function capturedOperations(harness: MatrixHarness): string[] {
  return harness.upstream.requests.map((request) => {
    const kind = request.path === "/chat/completions" ? "chat"
      : request.path === "/v1/messages" ? "messages" : "responses";
    const body = JSON.parse(decoder.decode(request.body)) as { stream?: boolean };
    return body.stream === true ? `${kind}-stream` : kind;
  });
}

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

describe("protocol conversion safety evidence", () => {
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
});

describe("converted output sanitization evidence", () => {
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
});
