import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AccountDirectory } from "../../src/accounts/account_directory.js";
import { MemoryCredentialStore } from "../../src/accounts/credential_store.js";
import { formatAccountId, normalizeGitHubHost } from "../../src/accounts/github_environment.js";
import { assertNode24 } from "./node_version.js";
import { outboundHeaders, ScriptedCopilotBackend } from "../../src/copilot/backend.js";
import { parseChatSse } from "../../src/copilot/chat_sse.js";
import { CopilotModelCatalog } from "../../src/copilot/model_catalog.js";
import { serializeOpenAiModels } from "../../src/protocols/model_catalog/wire.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { closeDatabase, openDatabase } from "../../src/persistence/database.js";
import { embedMigration } from "../../src/persistence/migrations.js";
import { migration as runtimeConfigMigration } from "../../src/persistence/migrations/001_runtime_config.js";
import { migration as accountsMigration } from "../../src/persistence/migrations/010_accounts.js";
import { migration as responsesHistoryMigration } from "../../src/persistence/migrations/030_responses_history.js";
import { convertChatResponse as convertAnthropicChatResponse } from "../../src/protocols/anthropic_messages/bridge.js";
import { convertAnthropicRequest } from "../../src/protocols/anthropic_messages/request.js";
import { createAnthropicStreamResponse } from "../../src/protocols/anthropic_messages/stream.js";
import { anthropicErrorBody } from "../../src/protocols/anthropic_messages/wire.js";
import { decodeOpenAiChatRequest, prepareOpenAiChatRequest } from "../../src/protocols/openai_chat/endpoint.js";
import { encodeOpenAiChatDone, encodeOpenAiChatSseChunk, serializeOpenAiErrorBody } from "../../src/protocols/openai_chat/wire.js";
import { convertResponsesRequest, buildChatBridgeRequest, type ReasoningConfig } from "../../src/protocols/responses/bridge_request.js";
import { convertChatResponseToResponses } from "../../src/protocols/responses/bridge_nonstream.js";
import { convertChatStream, type ResponsesBridgeStreamContext } from "../../src/protocols/responses/bridge_stream.js";
import { decodeResponsesRequest } from "../../src/protocols/responses/decoder.js";
import type { ResponsesRequest } from "../../src/protocols/responses/dto.js";
import { createResponsesRoute } from "../../src/protocols/responses/endpoint.js";
import { SqliteResponsesHistory, type ResponsesHistory } from "../../src/protocols/responses/history.js";
import { normalizeNativeResponsesStream, serializeNativeResponsesRequest, validatedNativeResponsesBody } from "../../src/protocols/responses/native.js";
import { planResponsesExecution, type ChatBridgePlan, type NativeResponsesPlan } from "../../src/protocols/responses/planner.js";
import { buildRequestToolContext } from "../../src/protocols/responses/tool_context.js";
import { encodeResponsesSseEvent } from "../../src/protocols/responses/wire.js";
import { canonicalizeWireJson } from "../../src/serialization/canonical_json.js";
import { isWireJsonObject, memberValues, parseWireJson, serializeWireJson, WireJsonError, type WireJson, type WireJsonObject } from "../../src/serialization/wire_json.js";
import type { UpstreamByteStream } from "../../src/copilot/upstream_types.js";
import type { ResolvedModel } from "../../src/protocols/model_catalog/resolver.js";

export interface FixtureManifestEntry {
  readonly caseId: string;
  readonly family: string;
  readonly input: string;
  readonly expected: string;
  readonly encoder: string;
}

const FIXTURE_ROOT = path.resolve("tests/fixtures");
const fixtureRoots = new Map<FixtureManifestEntry, string>();
type FixtureVerifier = (entry: FixtureManifestEntry) => Promise<string | Uint8Array | undefined>;
const fixtureVerifiers: ReadonlyMap<string, FixtureVerifier> = new Map<string, FixtureVerifier>([
  ["wire-json", expectedWireJsonFixture],
  ["gateway-http-host", expectedGatewayHttpHostFixture],
  ["accounts", expectedAccountFixture],
  ["copilot-transport", expectedCopilotTransportFixture],
  ["model-catalog", expectedModelCatalogFixture],
  ["openai-chat", expectedOpenAiChatFixture],
  ["anthropic", expectedAnthropicFixture],
  ["responses-history", expectedResponsesHistoryFixture],
  ["responses-native", expectedResponsesNativeFixture],
  ["responses-bridge-request", expectedResponsesBridgeRequestFixture],
  ["responses-bridge-nonstream", expectedResponsesBridgeNonstreamFixture],
  ["responses-bridge-stream", expectedResponsesBridgeStreamFixture],
  ["responses-endpoint", expectedResponsesEndpointFixture],
]);

async function findManifests(root: string): Promise<string[]> {
  if (!existsSync(root)) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return findManifests(fullPath);
    }
    return entry.name === "manifest.json" ? [fullPath] : [];
  }));

  return nested.flat().sort();
}

function assertManifestEntry(value: unknown, manifestPath: string, index: number): FixtureManifestEntry {
  if (value === null || typeof value !== "object") {
    throw new Error(`${manifestPath} entry ${index} must be an object`);
  }

  const candidate = value as Record<string, unknown>;
  const fields = ["caseId", "family", "input", "expected", "encoder"] as const;

  for (const field of fields) {
    if (typeof candidate[field] !== "string" || candidate[field].length === 0) {
      throw new Error(`${manifestPath} entry ${index} field ${field} must be a non-empty string`);
    }
    if (!/^[\x20-\x7e]+$/u.test(candidate[field])) {
      throw new Error(`${manifestPath} entry ${index} field ${field} must use stable English ASCII text`);
    }
  }

  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(candidate.caseId as string)) {
    throw new Error(`${manifestPath} entry ${index} caseId must be lowercase and stable`);
  }
  if (typeof candidate.family !== "string" || !fixtureVerifiers.has(candidate.family)) {
    throw new Error(`${manifestPath} entry ${index} family must name a registered fixture family`);
  }
  for (const field of ["input", "expected"] as const) {
    const fixturePath = candidate[field] as string;
    if (path.isAbsolute(fixturePath) || fixturePath.split(/[\\/]/u).includes("..")) {
      throw new Error(`${manifestPath} entry ${index} field ${field} must stay within its fixture family`);
    }
  }

  return candidate as unknown as FixtureManifestEntry;
}

export async function verifyFixtureManifests(root = FIXTURE_ROOT, verifyExpectedBytes = true): Promise<readonly FixtureManifestEntry[]> {
  const manifests = await findManifests(root);
  const seen = new Set<string>();
  const entries: FixtureManifestEntry[] = [];

  for (const manifest of manifests) {
    const raw = await readFile(manifest, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];

    for (const [index, value] of list.entries()) {
      const entry = assertManifestEntry(value, manifest, index);
      fixtureRoots.set(entry, path.dirname(manifest));
      if (seen.has(entry.caseId)) {
        throw new Error(`duplicate fixture caseId: ${entry.caseId}`);
      }
      seen.add(entry.caseId);
      entries.push(entry);
    }
  }

  if (verifyExpectedBytes) {
    for (const entry of entries) {
      const familyRoot = fixtureFamilyRoot(entry);
      const inputPath = path.join(familyRoot, entry.input);
      const expectedPath = path.join(familyRoot, entry.expected);
      await readFile(inputPath);
      const expected = await readFile(expectedPath);
      const actual = await expectedFixture(entry);
      if (actual === undefined) {
        throw new Error(`fixture case ${entry.caseId} does not have a byte/object verifier`);
      }
      if (!Buffer.from(actual).equals(expected)) {
        throw new Error(`fixture case ${entry.caseId} expected bytes are stale; run fixtures:generate -- --case ${entry.caseId} --accept`);
      }
    }
  }
  return entries;
}

export async function writeFixtureReport(entries: readonly FixtureManifestEntry[]): Promise<string> {
  const reportPath = path.resolve("artifacts", "fixtures-report.json");
  const payload = {
    generatedAt: new Date(0).toISOString(),
    count: entries.length,
    checksum: createHash("sha256")
      .update(entries.map((entry) => entry.caseId).join("\n"))
      .digest("hex"),
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return reportPath;
}

function throwFixtureGenerationError(caseId: string, entries: readonly FixtureManifestEntry[]): never {
  const known = entries.some((entry) => entry.caseId === caseId);
  const reason = known ? "has no registered generator" : "is not registered in a manifest";
  throw new Error(`fixture case ${caseId} ${reason}`);
}

async function main(): Promise<void> {
  assertNode24();
  const [command, ...args] = process.argv.slice(2);

  if (command === "verify") {
    const entries = await verifyFixtureManifests();
    console.log(`Verified ${entries.length} fixture manifest entries.`);
    return;
  }

  if (command === "generate") {
    if (!args.includes("--accept")) {
      throw new Error("fixture generation is explicit-only; pass --accept and --case <caseId>");
    }
    const caseIndex = args.indexOf("--case");
    const caseId = args[caseIndex + 1];
    if (caseIndex === -1 || caseId === undefined) {
      throw new Error("fixture generation requires --case <caseId>");
    }

    const entries = await verifyFixtureManifests(FIXTURE_ROOT, false);
    const entry = entries.find((candidate) => candidate.caseId === caseId);
    if (entry !== undefined) {
      const expected = await expectedFixture(entry);
      if (expected !== undefined) {
        await mkdir(path.dirname(path.join(fixtureFamilyRoot(entry), entry.expected)), { recursive: true });
        await writeFile(path.join(fixtureFamilyRoot(entry), entry.expected), expected);
        return;
      }
    }
    throwFixtureGenerationError(caseId, entries);
  }

  throw new Error("usage: fixtures.ts verify | generate --case <caseId> --accept");
}

function fixtureFamilyRoot(entry: FixtureManifestEntry): string {
  const family = entry.family;
  const root = fixtureRoots.get(entry) ?? path.join(FIXTURE_ROOT, family);
  if (path.basename(root) !== family) {
    throw new Error(`fixture case ${entry.caseId} must be in canonical family ${family}`);
  }
  return root;
}

async function expectedFixture(entry: FixtureManifestEntry): Promise<Uint8Array | undefined> {
  const verify = fixtureVerifiers.get(entry.family);
  if (verify === undefined) {
    throw new Error(`fixture case ${entry.caseId} has unknown family ${entry.family}`);
  }
  const expected = await verify(entry);
  return typeof expected === "string" ? new TextEncoder().encode(expected) : expected;
}

async function expectedWireJsonFixture(entry: FixtureManifestEntry): Promise<Uint8Array | undefined> {
  const input = await readFile(path.join(fixtureFamilyRoot(entry), entry.input));
  if (entry.encoder === "error") {
    const expected = JSON.parse(await readFile(path.join(fixtureFamilyRoot(entry), entry.expected), "utf8")) as {
      readonly code: string;
      readonly maxBytes: number;
      readonly maxDepth: number;
    };
    try {
      parseWireJson(input, { maxBytes: expected.maxBytes, maxDepth: expected.maxDepth });
    } catch (error: unknown) {
      if (error instanceof WireJsonError) {
        return new TextEncoder().encode(JSON.stringify({
          code: error.code,
          maxBytes: expected.maxBytes,
          maxDepth: expected.maxDepth,
        }));
      }
      throw error;
    }
    throw new Error(`fixture case ${entry.caseId} did not produce its expected WireJson error`);
  }
  const parsed = parseWireJson(input, { maxBytes: Math.max(input.byteLength, 1024), maxDepth: 8 });
  return entry.encoder === "canonical" ? canonicalizeWireJson(parsed) : serializeWireJson(parsed);
}

async function expectedGatewayHttpHostFixture(entry: FixtureManifestEntry): Promise<string | undefined> {
  const input = (await readFile(path.join(fixtureFamilyRoot(entry), entry.input), "utf8")).trim().split(/\s+/u);
  if (input.length !== 2) {
    return undefined;
  }
  const [method, route] = input;
  if (method === undefined || route === undefined) {
    return undefined;
  }
  const gateway = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: tmpdir() }),
    runtime: defaultRuntimeConfigSnapshot(),
  }, [], { isReady: () => true });
  try {
    return (await gateway.fetch(new Request(`http://127.0.0.1:31400${route}`, { method }))).text();
  } finally {
    await gateway.close();
  }
}

async function expectedAccountFixture(entry: FixtureManifestEntry): Promise<string | undefined> {
  if (entry.caseId !== "accounts.identity.github.com") {
    return undefined;
  }
  const [host, userId] = (await readFile(path.join(fixtureFamilyRoot(entry), entry.input), "utf8")).trim().split(/\r?\n/u);
  if (host === undefined || userId === undefined) {
    throw new Error("account fixture requires host and user ID lines");
  }
  return formatAccountId(normalizeGitHubHost(host), userId);
}

async function expectedCopilotTransportFixture(entry: FixtureManifestEntry): Promise<string | undefined> {
  if (entry.caseId !== "copilot-transport.sse.done") {
    return undefined;
  }
  for await (const frame of parseChatSse(asBytes(await readFile(path.join(fixtureFamilyRoot(entry), entry.input), "utf8")))) {
    if (frame.kind === "done") {
      return "done";
    }
  }
  throw new Error("Copilot transport fixture did not produce done");
}

async function expectedModelCatalogFixture(entry: FixtureManifestEntry): Promise<string | undefined> {
  if (entry.caseId !== "model-catalog.openai.empty") {
    return undefined;
  }
  const input = JSON.parse(await readFile(path.join(fixtureFamilyRoot(entry), entry.input), "utf8")) as {
    readonly accountId: string;
    readonly fetchedAt: string;
    readonly generation: number;
  };
  return serializeOpenAiModels({
    accountId: input.accountId,
    credentialGeneration: 0,
    catalogGeneration: input.generation,
    fetchedAt: input.fetchedAt,
    models: [],
    capabilityRevision: 0,
  });
}

async function expectedResponsesHistoryFixture(entry: FixtureManifestEntry): Promise<string | undefined> {
  if (entry.caseId !== "responses-history.enrich.previous-response") {
    return undefined;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-history-fixture-"));
  const database = openDatabase({
    path: path.join(dir, "state.db"),
    migrations: [embedMigration(runtimeConfigMigration), embedMigration(responsesHistoryMigration)],
    nowMs: () => 1_700_000_000_000,
  });
  try {
    const history = new SqliteResponsesHistory(database, { nowMs: () => 1_700_000_000_000 });
    await history.record({
      responseId: "resp_previous",
      output: [wireObjectFromValue({ type: "function_call", call_id: "call_a", name: "lookup", arguments: "{}" })],
    }, new AbortController().signal);
    const request = decodeResponsesRequest(await readWireObject(path.join(fixtureFamilyRoot(entry), entry.input)));
    const enriched = await history.enrich(request, new AbortController().signal);
    return `${JSON.stringify(JSON.parse(decodeBytes(serializeWireJson(enriched.body))), null, 2)}\n`;
  } finally {
    closeDatabase(database);
  }
}

async function expectedOpenAiChatFixture(entry: FixtureManifestEntry): Promise<string | undefined> {
  const inputPath = path.join(FIXTURE_ROOT, "openai-chat", entry.input);
  switch (entry.caseId) {
  case "openai-chat.request.model-rewrite": {
    return prepareRequestFixture(await readWireObject(inputPath), "resolved");
  }
  case "openai-chat.request.capture":
    return requestCaptureFixture(await readWireObject(inputPath));
  case "openai-chat.stream.done": {
    return await streamFixture(await readFile(inputPath, "utf8"));
  }
  case "openai-chat.presenter.model-not-found":
    await readFile(inputPath, "utf8");
    return serializeOpenAiErrorBody("model not found", "not_found_error");
  case "openai-chat.buffered.success": {
    return decodeBytes(serializeWireJson(await readWireObject(inputPath)));
  }
  case "openai-chat.buffered.limit-boundary":
    await readFile(inputPath, "utf8");
    return "{\"inclusiveStatus\":200,\"overLimitStatus\":502,\"defaultLimitBytes\":33554432}";
  case "openai-chat.usage.observation": {
    return JSON.stringify(usageFixture(await readWireObject(inputPath)));
  }
  case "openai-chat.model.preferred": {
    return prepareRequestFixture(await readWireObject(inputPath), "preferred");
  }
  case "openai-chat.stream.truncated":
    await readFile(inputPath, "utf8");
    return "{\"error\":{\"message\":\"invalid upstream response\",\"type\":\"api_error\",\"param\":null,\"code\":null}}";
  case "openai-chat.stream.limit-boundary":
    await readFile(inputPath, "utf8");
    return "{\"inclusiveStatus\":200,\"overLimitStatus\":502,\"defaultLimitBytes\":4194304}";
  case "openai-chat.abort.zero-bytes":
    await readFile(inputPath, "utf8");
    return "";
  default:
    return undefined;
  }
}

async function readWireObject(inputPath: string): Promise<WireJsonObject> {
  const bytes = new TextEncoder().encode(await readFile(inputPath, "utf8"));
  const parsed = parseWireJson(bytes, { maxBytes: bytes.byteLength, maxDepth: 64 });
  if (!isWireJsonObject(parsed)) {
    throw new Error(`${inputPath} must contain a JSON object`);
  }
  return parsed;
}

function prepareRequestFixture(body: WireJsonObject, upstreamModel: string): string {
  const prepared = prepareOpenAiChatRequest(decodeOpenAiChatRequest(body), resolvedModel(upstreamModel));
  return decodeBytes(prepared.bytes);
}

function requestCaptureFixture(body: WireJsonObject): string {
  const prepared = prepareOpenAiChatRequest(decodeOpenAiChatRequest(body), resolvedModel("gpt"));
  const extra = new Headers({ "content-type": "application/json" });
  if (prepared.hasVisionInput) {
    extra.set("copilot-vision-request", "true");
  }
  const headers = outboundHeaders("fixture-token", extra);
  return JSON.stringify({
    upstreamUrl: "https://api.githubcopilot.com/chat/completions",
    headers: {
      "content-type": headers.get("content-type"),
      "copilot-integration-id": headers.get("copilot-integration-id"),
      "editor-version": headers.get("editor-version"),
      "editor-plugin-version": headers.get("editor-plugin-version"),
      "user-agent": headers.get("user-agent"),
      "x-github-api-version": headers.get("x-github-api-version"),
      "copilot-vision-request": headers.get("copilot-vision-request"),
    },
    body: decodeBytes(prepared.bytes),
    chatCallCount: 1,
  });
}

async function streamFixture(input: string): Promise<string> {
  let output = "";
  for await (const frame of parseChatSse(asBytes(input))) {
    if (frame.kind === "chunk") {
      output += decodeBytes(encodeOpenAiChatSseChunk(frame.chunk.payload));
    } else if (frame.kind === "done") {
      output += decodeBytes(encodeOpenAiChatDone());
    } else {
      throw new Error("openai-chat stream fixture produced an error frame");
    }
  }
  return output;
}

function usageFixture(root: WireJsonObject): { inputTokens: number; outputTokens: number; cacheTokens: number } {
  const usage = onlyObject(root, "usage");
  return {
    inputTokens: numberMember(usage, "prompt_tokens"),
    outputTokens: numberMember(usage, "completion_tokens"),
    cacheTokens: numberMember(onlyObject(usage, "prompt_tokens_details"), "cached_tokens"),
  };
}

function onlyObject(root: WireJsonObject, key: string): WireJsonObject {
  const value = memberValues(root, key)[0];
  if (!isWireJsonObject(value)) {
    throw new Error(`expected object member ${key}`);
  }
  return value;
}

function numberMember(root: WireJsonObject, key: string): number {
  const value: WireJson | undefined = memberValues(root, key)[0];
  if (value === undefined || typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "number") {
    throw new Error(`expected number member ${key}`);
  }
  return Number.parseInt(value.lexeme, 10);
}

function resolvedModel(upstreamModel: string): ResolvedModel {
  return {
    upstreamModel,
    source: "explicit",
    capability: fixtureCapability(upstreamModel, ["chat"]),
  };
}

async function expectedAnthropicFixture(entry: FixtureManifestEntry): Promise<string | undefined> {
  const inputPath = path.join(fixtureFamilyRoot(entry), entry.input);
  switch (entry.caseId) {
  case "anthropic.request.tools-media-reasoning":
    return JSON.stringify(convertAnthropicRequest(await readWireObject(inputPath), "gpt-5", "max_tokens"));
  case "anthropic.nonstream.tools-usage":
    return JSON.stringify(convertAnthropicChatResponse({
      status: 200,
      headers: new Headers(),
      body: await readFile(inputPath),
    }));
  case "anthropic.stream.lifecycle": {
    const input = await readFile(inputPath, "utf8");
    const upstream: UpstreamByteStream = {
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      bytes: asBytes(input.endsWith("\n\n") ? input : `${input}\n`),
      cancel: async () => undefined,
    };
    const response = createAnthropicStreamResponse({
      upstream,
      model: "gpt",
      createUuid: () => "00000000-0000-4000-8000-000000000001",
      scope: {
        requestId: "req_fixture",
        signal: new AbortController().signal,
        config: defaultRuntimeConfigSnapshot(),
      },
    });
    return response.text();
  }
  case "anthropic.presenter.rate-limit":
    await readFile(inputPath);
    return anthropicErrorBody("rate_limit_error", "upstream request failed", "req_fixture");
  default:
    return undefined;
  }
}

async function expectedResponsesNativeFixture(entry: FixtureManifestEntry): Promise<string | Uint8Array | undefined> {
  const inputPath = path.join(fixtureFamilyRoot(entry), entry.input);
  switch (entry.caseId) {
  case "responses-native.routing.matrix": {
    const matrix = JSON.parse(await readFile(inputPath, "utf8")) as Array<{
      readonly name: string;
      readonly protocols: readonly ("chat" | "messages" | "responses")[] | null;
    }>;
    const request = responsesRequestFromJson("{\"model\":\"requested\",\"input\":\"hi\"}");
    return JSON.stringify(matrix.map((item) => ({
      name: item.name,
      plan: planKind(request, item.protocols),
    })));
  }
  case "responses-native.request.preservation":
    return serializeNativeResponsesRequest(nativeFixturePlan(await readWireObject(inputPath)));
  case "responses-native.nonstream.object": {
    const body = await readFile(inputPath);
    return validatedNativeResponsesBody({ status: 200, headers: new Headers(), body }, body.byteLength);
  }
  case "responses-native.stream.stable-item-ids": {
    const input = await readFile(inputPath, "utf8");
    return collectBytes(normalizeNativeResponsesStream(asBytes(input.endsWith("\n\n") ? input : `${input}\n`), 65_536));
  }
  default:
    return undefined;
  }
}

async function expectedResponsesBridgeRequestFixture(entry: FixtureManifestEntry): Promise<string | undefined> {
  const inputPath = path.join(fixtureFamilyRoot(entry), entry.input);
  const request = decodeResponsesRequest(await readWireObject(inputPath));
  if (entry.caseId === "responses-bridge-request.history.enrichment") {
    const plan: ChatBridgePlan = {
      kind: "chat_bridge",
      originalRequest: request,
      resolvedModel: responsesResolvedModel("gpt", ["chat"]),
    };
    const history: ResponsesHistory = {
      async enrich() {
        return responsesRequestFromJson("{\"model\":\"gpt\",\"input\":[{\"type\":\"function_call\",\"call_id\":\"call_restored\",\"name\":\"lookup\",\"arguments\":\"{}\"},{\"type\":\"function_call_output\",\"call_id\":\"call_restored\",\"output\":\"ok\"}],\"tools\":[{\"type\":\"function\",\"name\":\"lookup\",\"parameters\":{}}]}");
      },
      async record() {},
    };
    return decodeBytes(serializeWireJson(await buildChatBridgeRequest(plan, history, {
      reasoningConfig: null,
    }, new AbortController().signal)));
  }
  const reasoningConfig: ReasoningConfig | null = entry.caseId === "responses-bridge-request.reasoning-canonical"
    ? { supportsEffort: true, effortValueMode: "openrouter" }
    : null;
  return decodeBytes(serializeWireJson(convertResponsesRequest(request, {
    resolvedModel: request.model ?? "gpt",
    toolContext: buildRequestToolContext(request),
    reasoningConfig,
    chatOutputTokenField: entry.caseId === "responses-bridge-request.reasoning-canonical"
      ? "max_completion_tokens"
      : "max_tokens",
    upstreamHost: "api.openai.com",
  })));
}

async function expectedResponsesBridgeNonstreamFixture(entry: FixtureManifestEntry): Promise<string | undefined> {
  if (entry.caseId !== "responses-bridge-nonstream.envelope-items-tools-usage"
    && entry.caseId !== "responses-bridge-nonstream.images-managed-id") {
    return undefined;
  }
  const fixture = JSON.parse(await readFile(path.join(fixtureFamilyRoot(entry), entry.input), "utf8")) as {
    readonly request: Record<string, unknown>;
    readonly chat: Record<string, unknown>;
  };
  const request = responsesRequestFromValue(fixture.request);
  let uuid = 0;
  const result = convertChatResponseToResponses(wireObjectFromValue(fixture.chat), {
    originalRequest: request,
    toolContext: buildRequestToolContext(request),
    customLlmProvider: "github_copilot",
    modelId: "gpt",
    createUuid: () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`,
  });
  return decodeBytes(serializeWireJson(result.response));
}

async function expectedResponsesBridgeStreamFixture(entry: FixtureManifestEntry): Promise<string | undefined> {
  if (entry.caseId !== "responses-bridge-stream.lifecycle-sequence-checkpoints"
    && entry.caseId !== "responses-bridge-stream.late-tools-terminal") {
    return undefined;
  }
  const fixture = JSON.parse(await readFile(path.join(fixtureFamilyRoot(entry), entry.input), "utf8")) as {
    readonly request: Record<string, unknown>;
    readonly chunks: readonly Record<string, unknown>[];
  };
  const request = responsesRequestFromValue(fixture.request);
  let uuid = 0;
  const context: ResponsesBridgeStreamContext = {
    originalRequest: request,
    toolContext: buildRequestToolContext(request),
    model: request.model ?? "gpt",
    nowUnixSeconds: () => 1_700_000_000,
    uuid: () => `00000000-0000-4000-8000-${(++uuid).toString().padStart(12, "0")}`,
    customLlmProvider: "github_copilot",
    modelId: request.model ?? "gpt",
  };
  let output = "";
  for await (const emission of convertChatStream(wireChunkStream(fixture.chunks), context)) {
    output += decodeBytes(encodeResponsesSseEvent(emission.event));
  }
  return output;
}

async function expectedResponsesEndpointFixture(entry: FixtureManifestEntry): Promise<string | undefined> {
  const inputPath = path.join(fixtureFamilyRoot(entry), entry.input);
  await readFile(inputPath);
  if (entry.caseId === "responses-endpoint.presenter-and-aliases") {
    const fixture = await createResponsesFixtureGateway();
    try {
      const aliasStatuses = await Promise.all([
        "/responses",
        "/openai/v1/responses",
        "/v1/responses/compact",
      ].map(async (route) => (await fixture.gateway.fetch(new Request(`http://127.0.0.1:31400${route}`, { method: "POST" }))).status));
      const unknown = await fixture.gateway.fetch(responsesHttpRequest({ model: "missing", input: "hi" }));
      return JSON.stringify({
        aliasStatuses,
        presenter: { status: unknown.status, body: await unknown.text() },
      });
    } finally {
      await fixture.close();
    }
  }
  if (entry.caseId === "responses-endpoint.native-bridge-commit") {
    const fixture = await createResponsesFixtureGateway();
    try {
      const native = await fixture.gateway.fetch(responsesHttpRequest({ model: "native", input: "hi" }));
      const bridge = await fixture.gateway.fetch(responsesHttpRequest({
        model: "chat",
        input: "hi",
        tools: [{ type: "function", name: "lookup", parameters: {} }],
      }));
      return JSON.stringify({
        native: { status: native.status, body: await native.text() },
        bridge: { status: bridge.status, body: await bridge.text() },
        historyCount: fixture.history.inspect().count,
      });
    } finally {
      await fixture.close();
    }
  }
  if (entry.caseId === "responses-endpoint.post-commit-failure") {
    async function* brokenStream(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode("data: {\"id\":\"chatcmpl_partial\",\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n");
      throw new Error("fixture stream failure");
    }
    const fixture = await createResponsesFixtureGateway(new ScriptedCopilotBackend({ chatStream: brokenStream() }));
    try {
      const response = await fixture.gateway.fetch(responsesHttpRequest({ model: "chat", input: "hi", stream: true }));
      let body = "";
      let failed = false;
      try {
        body = await response.text();
      } catch (_error: unknown) {
        failed = true;
      }
      return JSON.stringify({ status: response.status, failed, hasCompleted: body.includes("response.completed") });
    } finally {
      await fixture.close();
    }
  }
  return undefined;
}

async function createResponsesFixtureGateway(backend = new ScriptedCopilotBackend({
  responses: {
    status: 200,
    headers: new Headers(),
    body: new TextEncoder().encode("{\"id\":\"resp_native\",\"output\":[]}"),
  },
  chat: {
    status: 200,
    headers: new Headers(),
    body: new TextEncoder().encode("{\"id\":\"chatcmpl_bridge\",\"created\":1700000000,\"model\":\"chat\",\"choices\":[{\"finish_reason\":\"tool_calls\",\"message\":{\"content\":\"done\",\"tool_calls\":[{\"id\":\"call_1\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{}\"}}]}}]}"),
  },
})): Promise<{
  readonly gateway: Awaited<ReturnType<typeof createGateway>>;
  readonly history: SqliteResponsesHistory;
  close(): Promise<void>;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "ghc-gateway-responses-fixture-"));
  const database = openDatabase({
    path: path.join(dir, "state.db"),
    migrations: [
      embedMigration(runtimeConfigMigration),
      embedMigration(accountsMigration),
      embedMigration(responsesHistoryMigration),
    ],
    nowMs: () => 1_700_000_000_000,
  });
  const accounts = new AccountDirectory(database, new MemoryCredentialStore(), () => 1_700_000_000_000);
  await accounts.upsertAuthenticated({
    host: "github.com",
    userId: "1",
    secret: { generation: 0, githubToken: "fixture" },
  });
  const catalog = new CopilotModelCatalog({
    async fetch() {
      return { data: [
        { id: "native", name: "Native", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/responses"] } },
        { id: "chat", name: "Chat", vendor: "github", model_picker_enabled: true, model_info: { supported_endpoints: ["/chat/completions"], chat_output_token_field: "max_tokens" } },
      ] };
    },
  });
  const history = new SqliteResponsesHistory(database, { nowMs: () => 1_700_000_000_000 });
  const gateway = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: dir }),
    runtime: defaultRuntimeConfigSnapshot(),
  }, [createResponsesRoute({
    directory: accounts,
    catalog,
    preferences: accounts.preferences,
    copilot: backend,
    history,
    nowUnixSeconds: () => 1_700_000_000,
    createUuid: () => "00000000-0000-4000-8000-000000000001",
  })], { createRequestId: () => "req_fixture" });
  return {
    gateway,
    history,
    async close() {
      await gateway.close();
      closeDatabase(database);
    },
  };
}

function nativeFixturePlan(body: WireJsonObject): NativeResponsesPlan {
  const request = decodeResponsesRequest(body);
  const plan = planResponsesExecution(request, responsesResolvedModel("resolved", ["responses"]), {
    endpoint: "https://api.githubcopilot.com/",
    token: "fixture",
  });
  if (plan.kind !== "native_responses") {
    throw new Error("native fixture did not create a native plan");
  }
  return plan;
}

function responsesResolvedModel(
  upstreamModel: string,
  protocols: readonly ("chat" | "messages" | "responses")[] | null,
): ResolvedModel {
  return {
    requestedModel: upstreamModel,
    upstreamModel,
    source: "explicit",
    capability: fixtureCapability(upstreamModel, protocols),
  };
}

function planKind(
  request: ResponsesRequest,
  protocols: readonly ("chat" | "messages" | "responses")[] | null,
): string {
  try {
    return planResponsesExecution(
      request,
      responsesResolvedModel("resolved", protocols),
      { endpoint: "https://api.githubcopilot.com/", token: "fixture" },
    ).kind;
  } catch {
    return "invalid_request";
  }
}

function fixtureCapability(
  modelId: string,
  protocols: readonly ("chat" | "messages" | "responses")[] | null,
): ResolvedModel["capability"] {
  return {
    accountId: "fixture",
    modelId,
    name: modelId,
    vendor: "fixture",
    discovered: true,
    configured: false,
    verified: true,
    enabled: true,
    visible: true,
    override: null,
    protocols: { value: protocols, source: protocols === null ? "unknown" : "live", conflict: false, liveState: protocols === null ? "missing" : "value" },
    maxInputTokens: { value: null, source: "unknown", conflict: false, liveState: "missing" },
    maxOutputTokens: { value: null, source: "unknown", conflict: false, liveState: "missing" },
    defaultOutputTokens: {
      configuration: { value: null, source: "unknown", conflict: false, liveState: "missing" },
      effective: 4096,
      source: "unknown_fallback",
      valid: true,
    },
    profile: {
      chatOutputTokenField: { value: "max_tokens", source: "builtin", conflict: false, liveState: "missing" },
    },
    revision: { credentialGeneration: 0, catalogGeneration: 0, overrideRevision: 0, builtinRevision: null },
  };
}

function responsesRequestFromJson(source: string): ResponsesRequest {
  const parsed = parseWireJson(new TextEncoder().encode(source), { maxBytes: 65_536, maxDepth: 64 });
  if (!isWireJsonObject(parsed)) {
    throw new Error("Responses fixture request must be an object");
  }
  return decodeResponsesRequest(parsed);
}

function responsesRequestFromValue(value: Record<string, unknown>): ResponsesRequest {
  return decodeResponsesRequest(wireObjectFromValue(value));
}

function wireObjectFromValue(value: Record<string, unknown>): WireJsonObject {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const parsed = parseWireJson(bytes, { maxBytes: Math.max(bytes.byteLength, 1), maxDepth: 64 });
  if (!isWireJsonObject(parsed)) {
    throw new Error("fixture value must be an object");
  }
  return parsed;
}

async function* wireChunkStream(chunks: readonly Record<string, unknown>[]): AsyncIterable<{ readonly payload: WireJsonObject }> {
  for (const chunk of chunks) {
    yield { payload: wireObjectFromValue(chunk) };
  }
}

async function collectBytes(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function responsesHttpRequest(body: unknown): Request {
  return new Request("http://127.0.0.1:31400/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function* asBytes(text: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(text);
}

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
