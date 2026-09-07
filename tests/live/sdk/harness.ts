import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HttpControlClient } from "../../../src/cli/control_client.js";
import type { EffectiveModelCapabilitySnapshot } from "../../../src/copilot/capability_registry.js";
import type { ChatOutputTokenField } from "../../../src/copilot/model_capabilities.js";
import { UPSTREAM_PROTOCOL_HEADER } from "../../../src/gateway/execution_evidence.js";
import { planProtocolExecution } from "../../../src/protocols/conversion/planner.js";
import type { InferenceProtocol } from "../../../src/protocols/conversion/types.js";
import {
  isWireJsonObject,
  parseWireJson,
} from "../../../src/serialization/wire_json.js";

export const LIVE_SDK_TEST_GUARD = "GHC_GATEWAY_LIVE_TESTS";
export const LIVE_MAX_INFERENCE_CALLS = 12;
export const LIVE_REQUEST_TIMEOUT_MS = 30_000;
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
export const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 15_000;
const LIVE_UNAVAILABLE_REASONS = new Set(["catalog_not_declared"]);
const LIVE_UNSUPPORTED_STATUSES = new Set([403, 404]);

export type { InferenceProtocol };
export type LiveStatus = "passing" | "not_available" | "unsupported";
export type LiveRouteKey =
  | "c_to_c"
  | "c_to_m"
  | "c_to_r"
  | "m_to_c"
  | "m_to_m"
  | "m_to_r"
  | "r_to_c"
  | "r_to_m"
  | "r_to_r";

export interface LiveRoute {
  readonly key: LiveRouteKey;
  readonly source: InferenceProtocol;
  readonly target: InferenceProtocol;
  readonly envPrefix: string;
}

export const LIVE_ROUTES: readonly LiveRoute[] = [
  route("c_to_c", "chat", "chat"),
  route("c_to_m", "chat", "messages"),
  route("c_to_r", "chat", "responses"),
  route("m_to_c", "messages", "chat"),
  route("m_to_m", "messages", "messages"),
  route("m_to_r", "messages", "responses"),
  route("r_to_c", "responses", "chat"),
  route("r_to_m", "responses", "messages"),
  route("r_to_r", "responses", "responses"),
] as const;

export type LiveRouteSelection =
  | { readonly kind: "model"; readonly modelId: string }
  | { readonly kind: "unsupported"; readonly modelId: string; readonly expectedStatus: 403 | 404 }
  | { readonly kind: "unavailable"; readonly reason: "catalog_not_declared" };

export interface LiveConfiguration {
  readonly accountId: string;
  readonly dataDir: string | undefined;
  readonly baseUrl: string;
  readonly routes: Readonly<Record<LiveRouteKey, LiveRouteSelection>>;
}

export interface LiveCliAccount {
  readonly accountId: string;
  readonly state: "active" | "removing" | "removed";
}

export interface LiveCliAccounts {
  readonly defaultAccountId: string | null;
  readonly items: readonly LiveCliAccount[];
}

export interface LiveCapabilityModel {
  readonly id: string;
  readonly discovered: boolean;
  readonly configured: boolean;
  readonly verified: boolean;
  readonly enabled: boolean;
  readonly visible: boolean;
  readonly protocols: readonly InferenceProtocol[] | null;
  readonly protocolsSource: "admin_override" | "live" | "builtin" | "unknown";
  readonly protocolsConflict: boolean;
  readonly protocolsLiveState: "missing" | "value" | "malformed";
  readonly chatOutputTokenField: ChatOutputTokenField | null;
  readonly maxInputTokens: number | null;
  readonly maxOutputTokens: number | null;
}

export interface LiveCapabilityModels {
  readonly accountId: string;
  readonly credentialGeneration: number;
  readonly catalogGeneration: number;
  readonly capabilityRevision: number;
  readonly items: readonly LiveCapabilityModel[];
}

export interface LiveManagedState {
  readonly port: number;
  readonly managed: boolean;
  readonly accounts: LiveCliAccounts;
  readonly models: LiveCapabilityModels;
}

export interface LiveCallSnapshot {
  readonly inferenceCalls: number;
  readonly catalogCalls: number;
  readonly byPath: Readonly<Record<string, number>>;
  readonly byRoute: Readonly<Partial<Record<LiveRouteKey, number>>>;
  readonly observedUpstream: Readonly<Partial<Record<LiveRouteKey, InferenceProtocol>>>;
  readonly maxInferenceCalls: number;
}

export interface WeatherArguments {
  readonly city: string;
}

export interface WeatherResult {
  readonly city: string;
  readonly condition: "sunny";
  readonly temperature_c: 22;
}

export class LiveCallLedger {
  private inferenceCalls = 0;
  private catalogCalls = 0;
  private readonly byPath = new Map<string, number>();
  private readonly byRoute = new Map<LiveRouteKey, number>();
  private readonly observedUpstream = new Map<LiveRouteKey, InferenceProtocol>();
  private activeRoute: LiveRouteKey | undefined;

  constructor(readonly maxInferenceCalls = LIVE_MAX_INFERENCE_CALLS) {}

  fetch(origin: string): typeof globalThis.fetch {
    const expected = new URL(origin).origin;
    return async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.origin !== expected || url.hostname !== "127.0.0.1") {
        throw new Error("live SDK tests blocked a request outside the selected local gateway");
      }
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const path = url.pathname;
      let inferenceRoute: LiveRoute | undefined;
      if (method === "GET" && path === "/v1/models") {
        this.catalogCalls += 1;
      } else if (method === "POST" && isInferencePath(path)) {
        if (this.activeRoute === undefined) {
          throw new Error("live inference call is missing an explicit route ledger owner");
        }
        if (this.inferenceCalls >= this.maxInferenceCalls) {
          throw new Error(`live inference call budget exceeded (${this.maxInferenceCalls})`);
        }
        inferenceRoute = LIVE_ROUTES.find((routeItem) => routeItem.key === this.activeRoute);
        if (inferenceRoute === undefined) {
          throw new Error("live inference call has an unknown route ledger owner");
        }
        this.inferenceCalls += 1;
        this.byRoute.set(this.activeRoute, (this.byRoute.get(this.activeRoute) ?? 0) + 1);
      }
      this.byPath.set(`${method} ${path}`, (this.byPath.get(`${method} ${path}`) ?? 0) + 1);
      const response = await globalThis.fetch(input, init);
      if (inferenceRoute !== undefined && response.ok) {
        const observed = response.headers.get(UPSTREAM_PROTOCOL_HEADER);
        if (!isInferenceProtocol(observed) || observed !== inferenceRoute.target) {
          await cancelResponseBody(response);
          throw new Error("live inference response did not prove its expected upstream protocol");
        }
        const prior = this.observedUpstream.get(inferenceRoute.key);
        if (prior !== undefined && prior !== observed) {
          await cancelResponseBody(response);
          throw new Error("live inference route changed upstream protocol within one matrix cell");
        }
        this.observedUpstream.set(inferenceRoute.key, observed);
      }
      return response;
    };
  }

  async run<T>(routeKey: LiveRouteKey, operation: () => Promise<T>): Promise<T> {
    if (this.activeRoute !== undefined) {
      throw new Error("live route operations must be sequential");
    }
    this.activeRoute = routeKey;
    try {
      return await operation();
    } finally {
      this.activeRoute = undefined;
    }
  }

  snapshot(): LiveCallSnapshot {
    return {
      inferenceCalls: this.inferenceCalls,
      catalogCalls: this.catalogCalls,
      byPath: Object.fromEntries([...this.byPath.entries()].sort()),
      byRoute: Object.fromEntries([...this.byRoute.entries()].sort()),
      observedUpstream: Object.fromEntries([...this.observedUpstream.entries()].sort()),
      maxInferenceCalls: this.maxInferenceCalls,
    };
  }
}

export function parseWeatherArguments(value: unknown): WeatherArguments {
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  } catch (_error: unknown) {
    throw new Error("get_weather arguments must be valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || !("city" in parsed) || typeof parsed.city !== "string") {
    throw new Error("get_weather arguments must contain a city string");
  }
  return { city: parsed.city };
}

export function getWeather(city: string): WeatherResult {
  if (city !== "Tokyo") {
    throw new Error("get_weather live scenario expected Tokyo");
  }
  return { city, condition: "sunny", temperature_c: 22 };
}

export function assertNonEmptyArray(value: unknown, message: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(message);
  }
}

export function assertLiveSdkTestsEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env[LIVE_SDK_TEST_GUARD] !== "1") {
    throw new Error(`${LIVE_SDK_TEST_GUARD}=1 is required for manual live SDK tests`);
  }
}

export function readLiveConfiguration(env: NodeJS.ProcessEnv = process.env): LiveConfiguration {
  assertLiveSdkTestsEnabled(env);
  const accountId = requiredNonEmpty(env.GHC_GATEWAY_LIVE_ACCOUNT_ID, "GHC_GATEWAY_LIVE_ACCOUNT_ID");
  const routes = Object.fromEntries(LIVE_ROUTES.map((item) => [
    item.key,
    readRouteSelection(item, env),
  ])) as Record<LiveRouteKey, LiveRouteSelection>;
  return {
    accountId,
    dataDir: optionalNonEmpty(env.GHC_GATEWAY_LIVE_DATA_DIR, "GHC_GATEWAY_LIVE_DATA_DIR"),
    baseUrl: liveBaseUrl(env),
    routes,
  };
}

export function liveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  assertLiveSdkTestsEnabled(env);
  const url = new URL(env.GHC_GATEWAY_LIVE_BASE_URL ?? "http://127.0.0.1:31400");
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username !== "" || url.password !== "") {
    throw new Error("GHC_GATEWAY_LIVE_BASE_URL must be an unauthenticated http://127.0.0.1 URL");
  }
  url.pathname = url.pathname.replace(/\/$/u, "");
  return url.href.replace(/\/$/u, "");
}

export async function readLiveManagedState(
  configuration: Readonly<LiveConfiguration>,
  cwd = process.cwd(),
): Promise<LiveManagedState> {
  const status = await runCliJson<{
    readonly state: string;
    readonly managed: boolean | null;
    readonly port: number | null;
  }>(configuration.dataDir, ["status"], cwd);
  if (status.state !== "running" || status.managed !== true || status.port === null) {
    throw new Error("live SDK tests require the selected managed gateway to be running");
  }
  if (new URL(configuration.baseUrl).port !== String(status.port)) {
    throw new Error("GHC_GATEWAY_LIVE_BASE_URL does not match the managed gateway port");
  }
  const accounts = await runCliJson<LiveCliAccounts>(configuration.dataDir, ["accounts", "list"], cwd);
  assertSelectedDefaultAccount(configuration.accountId, accounts);
  const models = await readAdminModels(configuration);
  if (models.accountId !== configuration.accountId) {
    throw new Error("managed gateway returned a model catalog for a different account");
  }
  validateRouteSelections(configuration.routes, models.items, configuration.accountId);
  return { port: status.port, managed: true, accounts, models };
}

async function readAdminModels(
  configuration: Readonly<LiveConfiguration>,
): Promise<LiveCapabilityModels> {
  const origin = new URL(configuration.baseUrl).origin;
  const dataDir = configuration.dataDir ?? path.join(homedir(), ".ghc-gateway");
  let bootstrapUrl: string | undefined;
  let cookie: string | undefined;
  let csrfToken: string | undefined;
  const control = new HttpControlClient(
    globalThis.fetch,
    undefined,
    (url) => {
      bootstrapUrl = url;
    },
  );
  let models: LiveCapabilityModels | undefined;
  let readFailure: Error | undefined;
  try {
    await control.adminOpen({ dataDir, timeoutMs: LIVE_REQUEST_TIMEOUT_MS });
    const parsedBootstrapUrl = bootstrapUrl === undefined ? null : new URL(bootstrapUrl);
    if (parsedBootstrapUrl !== null && parsedBootstrapUrl.origin !== origin) {
      throw new Error("managed Admin bootstrap origin does not match the selected gateway");
    }
    const bootstrapToken = parsedBootstrapUrl === null
      ? null
      : new URLSearchParams(parsedBootstrapUrl.hash.slice(1)).get("bootstrap_token");
    if (bootstrapToken === null) {
      throw new Error("managed Admin bootstrap did not produce a token");
    }
    const bootstrap = await boundedLiveFetch(`${origin}/admin/api/v1/auth/bootstrap`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({ token: bootstrapToken }),
    });
    const bootstrapBody = await safeJson(bootstrap);
    if (!bootstrap.ok) {
      throw new Error(`managed Admin bootstrap failed: ${safeAdminErrorCode(bootstrapBody, bootstrap.status)}`);
    }
    cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    csrfToken = nestedString(bootstrapBody, ["data", "csrfToken"]);
    if (cookie === undefined || csrfToken === undefined) {
      throw new Error("managed Admin bootstrap returned an incomplete session");
    }
    const response = await boundedLiveFetch(
      `${origin}/admin/api/v1/models?accountId=${encodeURIComponent(configuration.accountId)}`,
      { headers: { cookie } },
    );
    const body = await safeJson(response);
    if (!response.ok) {
      throw new Error(`managed Admin model catalog failed: ${safeAdminErrorCode(body, response.status)}`);
    }
    const data = nestedObject(body, ["data"]);
    if (data === null) {
      throw new Error("managed Admin model catalog returned an invalid envelope");
    }
    models = data as unknown as LiveCapabilityModels;
  } catch (error: unknown) {
    readFailure = safeAdminReadFailure(error);
  }
  const logoutFailure = cookie === undefined || csrfToken === undefined
    ? undefined
    : await logoutAdminSession(origin, cookie, csrfToken);
  if (logoutFailure !== undefined) {
    throw readFailure === undefined
      ? logoutFailure
      : new Error("managed Admin model read and logout cleanup both failed");
  }
  if (readFailure !== undefined) {
    throw readFailure;
  }
  if (models === undefined) {
    throw new Error("managed Admin model catalog returned no result");
  }
  return models;
}

export function assertSelectedDefaultAccount(
  accountId: string,
  accounts: Readonly<LiveCliAccounts>,
): void {
  if (!accounts.items.some((account) => account.accountId === accountId && account.state === "active")) {
    throw new Error("GHC_GATEWAY_LIVE_ACCOUNT_ID is not an active managed gateway account");
  }
  if (accounts.defaultAccountId !== accountId) {
    throw new Error("GHC_GATEWAY_LIVE_ACCOUNT_ID must equal the current default account");
  }
}

export function validateRouteSelections(
  selections: Readonly<Record<LiveRouteKey, LiveRouteSelection>>,
  models: readonly LiveCapabilityModel[],
  accountId = "live-account",
): void {
  const byId = new Map(models.map((model) => [model.id, model]));
  for (const routeItem of LIVE_ROUTES) {
    const selection = selections[routeItem.key];
    if (selection.kind === "unavailable") {
      const declared = models.some((model) => model.visible && model.enabled
        && model.protocols !== null
        && plannedTarget(routeItem, model, routeProbeBody(routeItem.source, model.id), accountId) === routeItem.target);
      if (declared) {
        throw new Error(`${routeItem.envPrefix}_UNAVAILABLE conflicts with the current capability catalog`);
      }
      continue;
    }
    const model = byId.get(selection.modelId);
    if (model === undefined || !model.visible || !model.enabled) {
      throw new Error(`${routeItem.envPrefix} selected a model that is not enabled and visible`);
    }
    if (model.protocols === null || model.protocolsConflict || model.protocolsLiveState === "malformed") {
      throw new Error(`${routeItem.envPrefix} selected a model without an unambiguous native protocol declaration`);
    }
    const planned = plannedTarget(
      routeItem,
      model,
      routeProbeBody(routeItem.source, model.id),
      accountId,
    );
    if (planned !== routeItem.target) {
      throw new Error(`${routeItem.envPrefix} would plan ${planned ?? "no route"}, not ${routeItem.target}`);
    }
  }
}

export function assertLiveRequestPlan(
  routeKey: LiveRouteKey,
  modelId: string,
  body: unknown,
  models: readonly LiveCapabilityModel[],
  accountId: string,
): void {
  const routeItem = LIVE_ROUTES.find((candidate) => candidate.key === routeKey);
  const model = models.find((candidate) => candidate.id === modelId);
  if (routeItem === undefined || model === undefined) {
    throw new Error("live request plan is missing its explicit route or model");
  }
  const target = plannedTarget(routeItem, model, body, accountId);
  if (target !== routeItem.target) {
    throw new Error(`${routeItem.envPrefix} request would plan ${target ?? "no route"}, not ${routeItem.target}`);
  }
}

export function recordLiveStatus(
  check: string,
  status: LiveStatus,
  modelIds: readonly string[],
  details: Readonly<Record<string, unknown>> = {},
): void {
  console.info(JSON.stringify({ check, status, model_ids: modelIds, ...details }));
}

export function parseManagedConvertedResponseId(id: string): Readonly<{
  modelId: string;
  upstreamProtocol: InferenceProtocol;
  responseId: string;
}> | null {
  if (!id.startsWith("resp_")) {
    return null;
  }
  const encoded = id.slice("resp_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) {
    return null;
  }
  try {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.toString("base64") !== encoded) {
      return null;
    }
    const segments = decoded.toString("utf8").split(";");
    if (segments[0] !== "litellm:custom_llm_provider:github_copilot") {
      return null;
    }
    const values = new Map<string, string>();
    for (const segment of segments.slice(1)) {
      const separator = segment.indexOf(":");
      if (separator <= 0) {
        return null;
      }
      const key = segment.slice(0, separator);
      const value = segment.slice(separator + 1);
      if (value === "" || values.has(key)) {
        return null;
      }
      values.set(key, value);
    }
    const modelId = values.get("model_id");
    const upstreamProtocol = values.get("upstream_protocol");
    const responseId = values.get("response_id");
    if (modelId === undefined || responseId === undefined || !isInferenceProtocol(upstreamProtocol)) {
      return null;
    }
    return { modelId, upstreamProtocol, responseId };
  } catch (_error: unknown) {
    return null;
  }
}

export function isManagedBridgeResponseId(id: string): boolean {
  return parseManagedConvertedResponseId(id) !== null;
}

export function apiErrorStatus(error: unknown): number | null {
  if (error === null || typeof error !== "object" || !("status" in error)) {
    return null;
  }
  const status = Reflect.get(error, "status");
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}

export async function consumeAtLeastOne<T>(stream: AsyncIterable<T>): Promise<number> {
  let count = 0;
  const iterator = stream[Symbol.asyncIterator]();
  for (;;) {
    const item = await iterator.next();
    if (item.done === true) {
      break;
    }
    count += 1;
  }
  return count;
}

export async function expectCancelledStream<T>(
  stream: AsyncIterable<T>,
  abort: () => void,
  isCancellationError: (error: unknown) => boolean,
): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]();
  abort();
  const deadline = Date.now() + 5_000;
  try {
    for (;;) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error("cancelled live stream did not terminate within five seconds");
      }
      const outcome = await nextWithTimeout(iterator, remainingMs);
      if (outcome.kind === "done") {
        return;
      }
      if (outcome.kind === "rejected") {
        if (!isCancellationError(outcome.error)) {
          throw new Error("cancelled live stream ended with a non-cancellation failure");
        }
        return;
      }
    }
  } finally {
    await returnWithTimeout(iterator, 1_000);
  }
}

function route(
  key: LiveRouteKey,
  source: InferenceProtocol,
  target: InferenceProtocol,
): LiveRoute {
  return {
    key,
    source,
    target,
    envPrefix: `GHC_GATEWAY_LIVE_${key.toUpperCase()}`,
  };
}

function readRouteSelection(routeItem: Readonly<LiveRoute>, env: NodeJS.ProcessEnv): LiveRouteSelection {
  const model = optionalNonEmpty(env[`${routeItem.envPrefix}_MODEL`], `${routeItem.envPrefix}_MODEL`);
  const unsupportedModel = optionalNonEmpty(
    env[`${routeItem.envPrefix}_UNSUPPORTED_MODEL`],
    `${routeItem.envPrefix}_UNSUPPORTED_MODEL`,
  );
  const unavailable = optionalNonEmpty(
    env[`${routeItem.envPrefix}_UNAVAILABLE`],
    `${routeItem.envPrefix}_UNAVAILABLE`,
  );
  const selected = [model, unsupportedModel, unavailable].filter((value) => value !== undefined);
  if (selected.length !== 1) {
    throw new Error(`set exactly one of ${routeItem.envPrefix}_MODEL, _UNSUPPORTED_MODEL, or _UNAVAILABLE`);
  }
  if (model !== undefined) {
    return { kind: "model", modelId: model };
  }
  if (unsupportedModel !== undefined) {
    const rawStatus = requiredNonEmpty(
      env[`${routeItem.envPrefix}_UNSUPPORTED_STATUS`],
      `${routeItem.envPrefix}_UNSUPPORTED_STATUS`,
    );
    const status = Number(rawStatus);
    if (!LIVE_UNSUPPORTED_STATUSES.has(status)) {
      throw new Error(`${routeItem.envPrefix}_UNSUPPORTED_STATUS must be 403 or 404`);
    }
    return { kind: "unsupported", modelId: unsupportedModel, expectedStatus: status as 403 | 404 };
  }
  if (unavailable === undefined || !LIVE_UNAVAILABLE_REASONS.has(unavailable)) {
    throw new Error(`${routeItem.envPrefix}_UNAVAILABLE must be catalog_not_declared`);
  }
  return { kind: "unavailable", reason: "catalog_not_declared" };
}

async function runCliJson<T>(
  dataDir: string | undefined,
  command: readonly string[],
  cwd: string,
): Promise<T> {
  const entry = path.resolve(cwd, "dist", "src", "cli", "main.js");
  const args = [
    entry,
    "--json",
    ...(dataDir === undefined ? [] : ["--data-dir", dataDir]),
    ...command,
  ];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, {
      cwd,
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    }));
  } catch (error: unknown) {
    const code = safeCliErrorCode(error);
    throw new Error(`managed gateway CLI command failed: ${code ?? "unknown_error"}`);
  }
  const envelope = JSON.parse(stdout) as unknown;
  if (envelope === null || typeof envelope !== "object"
    || !("ok" in envelope) || Reflect.get(envelope, "ok") !== true || !("data" in envelope)) {
    throw new Error("managed gateway CLI returned an invalid JSON envelope");
  }
  return Reflect.get(envelope, "data") as T;
}

function requiredNonEmpty(value: string | undefined, name: string): string {
  const normalized = optionalNonEmpty(value, name);
  if (normalized === undefined) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function optionalNonEmpty(value: string | undefined, name: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim() === "") {
    throw new Error(`${name} must not be empty`);
  }
  return value.trim();
}

function isInferencePath(pathname: string): boolean {
  return pathname === "/v1/chat/completions"
    || pathname === "/v1/messages"
    || pathname === "/v1/responses";
}

function isInferenceProtocol(value: unknown): value is InferenceProtocol {
  return value === "chat" || value === "messages" || value === "responses";
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch (_error: unknown) {
    return null;
  }
}

async function boundedLiveFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  return await globalThis.fetch(input, {
    ...init,
    signal: AbortSignal.timeout(LIVE_REQUEST_TIMEOUT_MS),
  });
}

function safeAdminReadFailure(error: unknown): Error {
  return error instanceof Error && error.message.startsWith("managed Admin ")
    ? error
    : new Error("managed Admin request failed: network_error");
}

async function logoutAdminSession(
  origin: string,
  cookie: string,
  csrfToken: string,
): Promise<Error | undefined> {
  let logout: Response;
  try {
    logout = await boundedLiveFetch(`${origin}/admin/api/v1/auth/logout`, {
      method: "POST",
      headers: {
        cookie,
        "x-ghcg-csrf": csrfToken,
        origin,
      },
    });
  } catch (_error: unknown) {
    return new Error("managed Admin logout failed: network_error");
  }
  return logout.ok
    ? undefined
    : new Error(`managed Admin logout failed: ${safeAdminErrorCode(await safeJson(logout), logout.status)}`);
}

function safeAdminErrorCode(body: unknown, status: number): string {
  const code = nestedString(body, ["error", "code"]);
  return code !== undefined && /^[a-z_]{1,64}$/u.test(code)
    ? code
    : `http_${status}`;
}

function nestedObject(
  value: unknown,
  pathParts: readonly string[],
): Readonly<Record<string, unknown>> | null {
  let current = value;
  for (const part of pathParts) {
    if (current === null || typeof current !== "object" || !(part in current)) {
      return null;
    }
    current = Reflect.get(current, part);
  }
  return current !== null && typeof current === "object" && !Array.isArray(current)
    ? current as Readonly<Record<string, unknown>>
    : null;
}

function nestedString(value: unknown, pathParts: readonly string[]): string | undefined {
  const parent = nestedObject(value, pathParts.slice(0, -1));
  const key = pathParts.at(-1);
  if (parent === null || key === undefined) {
    return undefined;
  }
  const candidate = parent[key];
  return typeof candidate === "string" ? candidate : undefined;
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<
  | { readonly kind: "value" }
  | { readonly kind: "done" }
  | { readonly kind: "rejected"; readonly error: unknown }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(iterator.next()).then(
        (result) => result.done === true
          ? { kind: "done" as const }
          : { kind: "value" as const },
        (error: unknown) => ({ kind: "rejected" as const, error }),
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("cancelled live stream did not terminate within five seconds")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function returnWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<void> {
  if (iterator.return === undefined) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(iterator.return()).then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body === null) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      response.body.cancel().then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function plannedTarget(
  routeItem: Readonly<LiveRoute>,
  model: Readonly<LiveCapabilityModel>,
  body: unknown,
  accountId: string,
): InferenceProtocol | null {
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const wire = parseWireJson(bytes, { maxBytes: 1024 * 1024, maxDepth: 64 });
    if (!isWireJsonObject(wire)) {
      return null;
    }
    return planProtocolExecution({
      source: routeItem.source,
      body: wire,
      stream: isStreamingBody(body),
      resolvedModel: model.id,
      capability: planningCapability(model, accountId),
    }).target;
  } catch (_error: unknown) {
    return null;
  }
}

function planningCapability(
  model: Readonly<LiveCapabilityModel>,
  accountId: string,
): EffectiveModelCapabilitySnapshot {
  return {
    accountId,
    modelId: model.id,
    name: model.id,
    vendor: "unknown",
    discovered: model.discovered,
    configured: model.configured,
    verified: model.verified,
    enabled: model.enabled,
    visible: model.visible,
    override: null,
    protocols: {
      value: model.protocols,
      source: model.protocolsSource,
      conflict: model.protocolsConflict,
      liveState: model.protocolsLiveState,
    },
    maxInputTokens: unknownField(model.maxInputTokens),
    maxOutputTokens: unknownField(model.maxOutputTokens),
    defaultOutputTokens: {
      configuration: unknownField<number>(null),
      effective: Math.min(8192, model.maxOutputTokens ?? 4096),
      source: model.maxOutputTokens === null ? "unknown_fallback" : "known_ceiling",
      valid: true,
    },
    profile: {
      chatOutputTokenField: unknownField(model.chatOutputTokenField),
      supportedParameters: unknownField<readonly string[]>(null),
      reasoningEfforts: unknownField<readonly ("none" | "minimal" | "low" | "medium" | "high" | "xhigh")[]>(null),
    },
    revision: {
      credentialGeneration: 0,
      catalogGeneration: 0,
      overrideRevision: 0,
      builtinRevision: null,
    },
  };
}

function unknownField<T>(value: T | null): Readonly<{
  value: T | null;
  source: "unknown";
  conflict: false;
  liveState: "value" | "missing";
}> {
  return {
    value,
    source: "unknown",
    conflict: false,
    liveState: value === null ? "missing" : "value",
  };
}

function routeProbeBody(
  source: InferenceProtocol,
  model: string,
): Readonly<Record<string, unknown>> {
  if (source === "chat") {
    return { model, messages: [{ role: "user", content: "route probe" }] };
  }
  if (source === "messages") {
    return { model, max_tokens: 1, messages: [{ role: "user", content: "route probe" }] };
  }
  return { model, max_output_tokens: 1, input: "route probe" };
}

function isStreamingBody(body: unknown): boolean {
  return body !== null && typeof body === "object" && Reflect.get(body, "stream") === true;
}

function safeCliErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") {
    return null;
  }
  for (const key of ["stdout", "stderr"] as const) {
    const text = Reflect.get(error, key);
    if (typeof text !== "string" || text.trim() === "") {
      continue;
    }
    try {
      const envelope = JSON.parse(text) as unknown;
      if (envelope !== null && typeof envelope === "object"
        && Reflect.get(envelope, "ok") === false) {
        const failure = Reflect.get(envelope, "error");
        const code = failure !== null && typeof failure === "object"
          ? Reflect.get(failure, "code")
          : null;
        if (typeof code === "string" && /^[a-z_]{1,64}$/u.test(code)) {
          return code;
        }
      }
    } catch (_error: unknown) {
      continue;
    }
  }
  return null;
}
