import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { ModelCapabilityRegistry } from "../../src/copilot/capability_registry.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { migration as responsesHistoryMigration } from "../../src/persistence/migrations/030_responses_history.js";
import { migration as responsesContinuationMigration } from "../../src/persistence/migrations/041_responses_continuation_ownership.js";
import type {
  MessagesUpstreamRequest,
  NativeResponsesUpstreamRequest,
} from "../../src/copilot/upstream_types.js";
import type { ChatRequest } from "../../src/protocols/chat_completions/types.js";
import { SqliteResponsesHistory } from "../../src/protocols/responses/history.js";
import { bootstrapGateway } from "../../src/main.js";

export const SDK_TEST_GUARD = "GHC_GATEWAY_SDK_TESTS";
export const CHAT_MODEL = "chat-sdk";
export const REASONING_MODEL = "gpt-5";
export const NATIVE_RESPONSES_MODEL = "responses-sdk";
export const MESSAGES_MODEL = "messages-sdk";
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
export const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

export function getWeather(city: string): Readonly<{ city: string; condition: "sunny"; temperature_c: 22 }> {
  if (city !== "Tokyo") {
    throw new Error("get_weather offline scenario expected Tokyo");
  }
  return { city, condition: "sunny", temperature_c: 22 };
}

const encoder = new TextEncoder();
const nativeFetch = globalThis.fetch;
const nowMs = (): number => 1_700_000_000_000;

export interface OfflineSdkHarness {
  readonly baseUrl: string;
  readonly openAiBaseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly chatRequests: ChatRequest[];
  readonly responsesRequests: NativeResponsesUpstreamRequest[];
  readonly messagesRequests: MessagesUpstreamRequest[];
  readonly backendKinds: readonly string[];
  readonly cancelled: Readonly<{ chat: number; messages: number; responses: number }>;
  close(): Promise<void>;
}

export function assertOfflineSdkTestsEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env[SDK_TEST_GUARD] !== "1") {
    throw new Error(`${SDK_TEST_GUARD}=1 is required for manual offline SDK tests`);
  }
}

export async function startOfflineSdkHarness(): Promise<OfflineSdkHarness> {
  assertOfflineSdkTestsEnabled();
  const artifactRoot = path.resolve("artifacts", "test-data");
  await mkdir(artifactRoot, { recursive: true });
  const dataDir = await mkdtemp(path.join(artifactRoot, "ghc-gateway-sdk-"));
  const port = await reserveLoopbackPort();
  const database = openDatabase({
    path: path.join(dataDir, "state.db"),
    migrations: [
      embedMigration(runtimeConfigMigration),
      embedMigration(accountsMigration),
      embedMigration(responsesHistoryMigration),
      embedMigration(responsesContinuationMigration),
    ],
    nowMs,
  });
  const directory = new AccountDirectory(database, new MemoryCredentialStore(), nowMs);
  await directory.upsertAuthenticated({
    host: "github.com",
    userId: "1",
    secret: { generation: 0, githubToken: "sdk-scripted-token" },
  });
  const catalog = new CopilotModelCatalog({
    async fetch() {
      return {
        data: [
          { id: CHAT_MODEL, name: "SDK Chat", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/v1/chat/completions"], supported_parameters: ["temperature", "top_p", "response_format", "reasoning_effort"], supported_reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh"], max_input_tokens: 128_000, max_output_tokens: 16_384, chat_output_token_field: "max_tokens" } },
          { id: REASONING_MODEL, name: "SDK Reasoning", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/v1/chat/completions"], supported_parameters: ["temperature", "top_p", "response_format", "reasoning_effort"], supported_reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh"], max_input_tokens: 128_000, max_output_tokens: 16_384, chat_output_token_field: "max_tokens" } },
          { id: NATIVE_RESPONSES_MODEL, name: "SDK Responses", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/v1/responses"], supported_parameters: ["temperature", "top_p", "response_format", "reasoning"], supported_reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh"], max_input_tokens: 128_000, max_output_tokens: 16_384 } },
          { id: MESSAGES_MODEL, name: "SDK Messages", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/v1/messages"], supported_parameters: ["temperature", "top_p", "output_config.format", "output_config.effort"], supported_reasoning_efforts: ["none", "minimal", "low", "medium", "high", "xhigh"], max_input_tokens: 128_000, max_output_tokens: 16_384, default_output_tokens: 4_096 } },
        ],
      };
    },
  }, () => new Date(nowMs()));
  const history = new SqliteResponsesHistory(database, { nowMs });
  const registry = new ModelCapabilityRegistry(
    catalog,
    { get: () => null },
  );
  const chatRequests: ChatRequest[] = [];
  const responsesRequests: NativeResponsesUpstreamRequest[] = [];
  const messagesRequests: MessagesUpstreamRequest[] = [];
  const cancellation = { chat: 0, messages: 0, responses: 0 };
  const backend = new ScriptedCopilotBackend({
    chat(request) {
      chatRequests.push(request);
      return {
        status: 200,
        headers: new Headers({ "x-scripted-remote": "chat" }),
        body: jsonBytes(scriptedChatCompletion(request.body)),
      };
    },
    chatStream(request) {
      chatRequests.push(request);
      return isCancellationRequest(request.body)
        ? cancellableChatStream(request.signal, cancellation)
        : scriptedChatStream(request.body);
    },
    responses(request) {
      responsesRequests.push(request);
      return {
        status: 200,
        headers: new Headers({ "x-scripted-remote": "responses" }),
        body: jsonBytes(scriptedResponsesObject(request.body)),
      };
    },
    responsesStream(request) {
      responsesRequests.push(request);
      return isCancellationRequest(request.body)
        ? cancellableResponsesStream(request.signal, cancellation)
        : scriptedResponsesStream(request.body);
    },
    messages(request) {
      messagesRequests.push(request);
      return {
        status: 200,
        headers: new Headers({ "x-scripted-remote": "messages" }),
        body: jsonBytes(scriptedMessagesObject(request.body)),
      };
    },
    messagesStream(request) {
      messagesRequests.push(request);
      return isCancellationRequest(request.body)
        ? cancellableMessagesStream(request.signal, cancellation)
        : scriptedMessagesStream(request.body);
    },
  });
  let databaseClosed = false;
  const closeState = (): void => {
    if (!databaseClosed) {
      databaseClosed = true;
      closeDatabase(database);
    }
  };
  const gateway = await bootstrapGateway({
    startup: { host: "127.0.0.1", port, dataDir, logLevel: "error" },
    application: {
      database,
      credentials: new MemoryCredentialStore(),
      directory,
      registry,
      copilot: backend,
      history,
      async close() {
        await registry.close();
        closeState();
      },
      forceClose: closeState,
    },
    dependencies: { createRequestId: () => "req_sdk_loopback" },
  });
  try {
    await gateway.listen();
  } catch (error: unknown) {
    await gateway.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    openAiBaseUrl: `${baseUrl}/v1`,
    fetch: loopbackOnlyFetch(baseUrl),
    chatRequests,
    responsesRequests,
    messagesRequests,
    get backendKinds() {
      return backend.captured.map((entry) => entry.kind);
    },
    cancelled: cancellation,
    async close() {
      await gateway.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export function decodeCapturedBody(
  request: ChatRequest | NativeResponsesUpstreamRequest | MessagesUpstreamRequest,
): unknown {
  return JSON.parse(new TextDecoder().decode(request.body)) as unknown;
}

export async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for SDK cancellation");
}

function loopbackOnlyFetch(origin: string): typeof globalThis.fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== origin || url.hostname !== "127.0.0.1") {
      throw new Error("offline SDK tests blocked a non-loopback request");
    }
    return await nativeFetch(input, init);
  };
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("failed to reserve SDK loopback port");
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  return address.port;
}

function chatCompletion(
  content: string | null = "pong",
  model = CHAT_MODEL,
  extraMessage: Readonly<Record<string, unknown>> = {},
  finishReason = "stop",
): Record<string, unknown> {
  return {
    id: "chatcmpl_sdk",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, message: { role: "assistant", content, ...extraMessage }, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function scriptedChatCompletion(body: Uint8Array): Record<string, unknown> {
  const request = decodedBody(body);
  const model = typeof request.model === "string" ? request.model : CHAT_MODEL;
  if (containsRole(request, "tool")) {
    return chatCompletion("Tool result accepted.", model);
  }
  if (Array.isArray(request.tools)) {
    return chatCompletion(null, model, {
      tool_calls: [{
        id: "call_weather",
        index: 0,
        type: "function",
        function: { name: "get_weather", arguments: "{\"city\":\"Tokyo\"}" },
      }],
    }, "tool_calls");
  }
  if (typeof request.reasoning_effort === "string") {
    return chatCompletion("Reasoned answer.", model, { reasoning_content: `reason-${request.reasoning_effort}` });
  }
  return chatCompletion(serialized(body).includes("image_url") ? "Image accepted." : "pong", model);
}

function chatCompletionChunk(model = CHAT_MODEL): Record<string, unknown> {
  return {
    id: "chatcmpl_sdk_stream",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
  };
}

function scriptedChatStream(body: Uint8Array): Uint8Array[] {
  const request = decodedBody(body);
  const model = typeof request.model === "string" ? request.model : CHAT_MODEL;
  if (Array.isArray(request.tools)) {
    return [
      chatSse(chatToolChunk(model, {
        index: 0,
        id: "call_stream",
        type: "function",
        function: { name: "get_weather", arguments: "{\"city\":" },
      })),
      chatSse(chatToolChunk(model, { index: 0, function: { arguments: "\"Tokyo\"}" } })),
      chatSse({
        ...chatCompletionChunk(model),
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }),
      encoder.encode("data: [DONE]\n\n"),
    ];
  }
  return [chatSse(chatCompletionChunk(model)), encoder.encode("data: [DONE]\n\n")];
}

function chatToolChunk(model: string, toolCall: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    ...chatCompletionChunk(model),
    choices: [{ index: 0, delta: { tool_calls: [toolCall] }, finish_reason: null }],
  };
}

function responsesObject(
  status: "in_progress" | "completed",
  output?: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const completed = status === "completed";
  return {
    id: "resp_sdk",
    object: "response",
    created_at: 1_700_000_000,
    status,
    completed_at: completed ? 1_700_000_001 : null,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: 8,
    metadata: null,
    model: NATIVE_RESPONSES_MODEL,
    output: output ?? (completed ? [{
      id: "msg_sdk",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "pong", annotations: [] }],
    }] : []),
    output_text: completed && output === undefined ? "pong" : "",
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: completed
      ? { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 }
      : null,
  };
}

function scriptedResponsesObject(body: Uint8Array): Record<string, unknown> {
  const request = decodedBody(body);
  if (hasFunctionCallOutput(request)) {
    return responsesObject("completed");
  }
  if (Array.isArray(request.tools)) {
    return responsesObject("completed", [{
      id: "fc_weather",
      type: "function_call",
      call_id: "call_weather",
      name: "get_weather",
      arguments: "{\"city\":\"Tokyo\"}",
      status: "completed",
    }]);
  }
  return responsesObject("completed");
}

function scriptedResponsesStream(body: Uint8Array): Uint8Array[] {
  const request = decodedBody(body);
  if (Array.isArray(request.tools)) {
    const inProgress = responsesObject("in_progress");
    const item = {
      id: "fc_stream",
      type: "function_call",
      call_id: "call_stream",
      name: "get_weather",
      arguments: "{\"city\":\"Tokyo\"}",
      status: "completed",
    };
    return [
      responsesSse("response.created", { type: "response.created", sequence_number: 0, response: inProgress }),
      responsesSse("response.output_item.added", {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: { ...item, arguments: "", status: "in_progress" },
      }),
      responsesSse("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        sequence_number: 2,
        item_id: item.id,
        output_index: 0,
        delta: "{\"city\":" ,
      }),
      responsesSse("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        sequence_number: 3,
        item_id: item.id,
        output_index: 0,
        delta: "\"Tokyo\"}",
      }),
      responsesSse("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        sequence_number: 4,
        item_id: item.id,
        output_index: 0,
        name: item.name,
        arguments: item.arguments,
      }),
      responsesSse("response.output_item.done", {
        type: "response.output_item.done",
        sequence_number: 5,
        output_index: 0,
        item,
      }),
      responsesSse("response.completed", {
        type: "response.completed",
        sequence_number: 6,
        response: responsesObject("completed", [item]),
      }),
    ];
  }
  return [responsesSse("response.completed", {
    type: "response.completed",
    sequence_number: 0,
    response: scriptedResponsesObject(body),
  })];
}

function scriptedMessagesObject(_body: Uint8Array): Record<string, unknown> {
  return {
    id: "msg_sdk",
    type: "message",
    role: "assistant",
    model: MESSAGES_MODEL,
    content: [{ type: "text", text: "pong" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function scriptedMessagesStream(_body: Uint8Array): Uint8Array[] {
  return [
    messagesSse("message_start", {
      type: "message_start",
      message: {
        id: "msg_sdk_stream",
        type: "message",
        role: "assistant",
        content: [],
        model: MESSAGES_MODEL,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    messagesSse("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    messagesSse("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "pong" },
    }),
    messagesSse("content_block_stop", { type: "content_block_stop", index: 0 }),
    messagesSse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    messagesSse("message_stop", { type: "message_stop" }),
  ];
}

async function* cancellableChatStream(
  signal: AbortSignal,
  cancellation: { chat: number },
): AsyncIterable<Uint8Array> {
  try {
    yield chatSse({
      ...chatCompletionChunk(),
      choices: [{ index: 0, delta: { role: "assistant", content: "waiting" }, finish_reason: null }],
    });
    await untilAborted(signal);
  } finally {
    cancellation.chat += 1;
  }
}

async function* cancellableResponsesStream(
  signal: AbortSignal,
  cancellation: { responses: number },
): AsyncIterable<Uint8Array> {
  try {
    yield responsesSse("response.created", { type: "response.created", response: responsesObject("in_progress") });
    await untilAborted(signal);
  } finally {
    cancellation.responses += 1;
  }
}

async function* cancellableMessagesStream(
  signal: AbortSignal,
  cancellation: { messages: number },
): AsyncIterable<Uint8Array> {
  try {
    yield messagesSse("message_start", {
      type: "message_start",
      message: {
        id: "msg_waiting",
        type: "message",
        role: "assistant",
        content: [],
        model: MESSAGES_MODEL,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    await untilAborted(signal);
  } finally {
    cancellation.messages += 1;
  }
}

async function untilAborted(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    throw signal.reason;
  }
  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function isCancellationRequest(body: Uint8Array): boolean {
  return new TextDecoder().decode(body).includes("cancel-sdk-request");
}

function decodedBody(body: Uint8Array): Record<string, unknown> {
  const value = JSON.parse(serialized(body)) as unknown;
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function serialized(body: Uint8Array): string {
  return new TextDecoder().decode(body);
}

function containsRole(value: unknown, role: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsRole(item, role));
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.role === role || Object.values(record).some((item) => containsRole(item, role));
}

function hasFunctionCallOutput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasFunctionCallOutput);
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.type === "function_call_output" || Object.values(record).some(hasFunctionCallOutput);
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function chatSse(value: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
}

function responsesSse(event: string, value: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function messagesSse(event: string, value: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}
