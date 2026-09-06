import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { RuntimeConfigSchema } from "../config/schema.js";
import type {
  AdminBootstrapResult,
  AdminModule,
  AdminRequestContext,
} from "../gateway/create_gateway.js";
import type { AdminEventQuery, AdminUsageQuery } from "../telemetry/admin.js";
import { AdminManagementApi, AdminApiError, mapAdminError, type AdminApiDependencies } from "./api.js";
import {
  AdminAuth,
  AdminAuthError,
  readSessionCookie,
  serializeExpiredSessionCookie,
  serializeSessionCookie,
} from "./auth.js";
import { AdminEventStreamHub } from "./events.js";

const BootstrapSchema = Type.Object({
  token: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
}, { additionalProperties: false });
const DeviceFlowStartSchema = Type.Object({ host: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const ExpectedRevisionSchema = Type.Object({ expectedRevision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
const DefaultAccountSchema = Type.Object({
  accountId: Type.String({ minLength: 1 }),
  expectedRevision: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
const PreferredModelSchema = Type.Object({
  accountId: Type.String({ minLength: 1 }),
  modelId: Type.String({ minLength: 1 }),
  expectedRevision: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
const RefreshModelsSchema = Type.Object({ accountId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const ModelIdSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
});
const ModelCapabilitiesSchema = Type.Object({
  accountId: Type.String({ minLength: 1 }),
  modelId: ModelIdSchema,
  expectedRevision: Type.Integer({ minimum: 0 }),
  capabilities: Type.Object({
    enabled: Type.Boolean(),
    protocols: Type.Optional(Type.Array(
      Type.Union([Type.Literal("chat"), Type.Literal("messages"), Type.Literal("responses")]),
      { uniqueItems: true, maxItems: 3 },
    )),
    maxInputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    maxOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    defaultOutputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    chatOutputTokenField: Type.Optional(Type.Union([
      Type.Literal("max_tokens"),
      Type.Literal("max_completion_tokens"),
    ])),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
const ModelCapabilitiesResetSchema = Type.Object({
  accountId: Type.String({ minLength: 1 }),
  modelId: ModelIdSchema,
  expectedRevision: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
const RuntimeConfigUpdateSchema = Type.Object({
  expectedRevision: Type.Integer({ minimum: 0 }),
  config: RuntimeConfigSchema,
}, { additionalProperties: false });

const PROTOCOLS = new Set(["openai_chat", "openai_responses_native", "openai_responses_bridge", "anthropic", "ollama"]);
const OUTCOMES = new Set(["success", "client_error", "authentication_error", "overloaded", "upstream_error", "timeout", "aborted", "internal_error"]);
const EVENT_KINDS = new Set([
  "gateway_started", "gateway_stopped", "request_failed", "account_authenticated", "account_removed",
  "default_account_changed", "preferred_model_changed", "runtime_config_changed", "catalog_refreshed",
  "performance_degraded", "performance_recovered", "telemetry_dropped", "metadata_rejected", "daemon_start_failed",
]);
const SEVERITIES = new Set(["info", "warning", "error"]);

export interface AdminModuleDependencies extends AdminApiDependencies {
  readonly nowMs?: () => number;
  readonly createToken?: () => string;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

export function createAdminModule(dependencies: Readonly<AdminModuleDependencies>): AdminModule {
  const api = new AdminManagementApi(dependencies);
  const auth = new AdminAuth(
    dependencies.nowMs ?? Date.now,
    dependencies.createToken,
    dependencies.setTimeout,
    dependencies.clearTimeout,
  );
  const eventHub = new AdminEventStreamHub(
    dependencies.telemetry,
    api,
    dependencies.setInterval,
    dependencies.clearInterval,
  );
  let closed = false;

  return {
    async handle(request, context) {
      if (closed) {
        return failure(new AdminApiError("unauthenticated"), context.requestId);
      }
      try {
        const bodyLimit = dependencies.runtimeConfig.read().config.limits.requestBodyBytes;
        return await dispatch(request, context, bodyLimit, auth, api, eventHub, dependencies.nowMs ?? Date.now);
      } catch (error: unknown) {
        if (context.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
          return new Response(null);
        }
        return failure(mapRouteError(error), context.requestId);
      }
    },
    mintBootstrap(): AdminBootstrapResult {
      return closed ? { kind: "closed" } : auth.mintBootstrap();
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      eventHub.close();
      auth.close();
    },
  };
}

async function dispatch(
  request: Request,
  context: Readonly<AdminRequestContext>,
  bodyLimit: number,
  auth: AdminAuth,
  api: AdminManagementApi,
  events: AdminEventStreamHub,
  nowMs: () => number,
): Promise<Response> {
  context.signal.throwIfAborted();
  const url = new URL(request.url);
  const route = matchRoute(request.method, url.pathname);
  if (route === null) {
    throw new AdminApiError("not_found");
  }
  rejectQuery(url, route.query);

  if (route.id === "bootstrap") {
    requireOrigin(request.headers, context.listenerOrigin);
    const body = checked(BootstrapSchema, await readJsonObject(request, bodyLimit, context.signal));
    const session = auth.exchange(body.token);
    const headers = responseHeaders(context.requestId);
    headers.set("Set-Cookie", serializeSessionCookie(session.sessionId, session.absoluteExpiresAtMs));
    return json(200, { data: auth.metadata(session) }, headers);
  }

  const sessionId = readSessionCookie(request.headers);
  const session = auth.requireSession(sessionId);
  if (route.mutation) {
    requireOrigin(request.headers, context.listenerOrigin);
    if (!auth.verifyCsrf(session, request.headers.get("x-ghcg-csrf"))) {
      throw new AdminApiError("forbidden");
    }
  }

  if (!route.body) {
    await requireNoBody(request, context.signal);
  }
  const body = route.body ? await readJsonObject(request, bodyLimit, context.signal) : undefined;
  let response: Response;
  switch (route.id) {
  case "session":
    response = json(200, { data: auth.metadata(session) }, responseHeaders(context.requestId));
    break;
  case "logout": {
    auth.logout(sessionId);
    const headers = responseHeaders(context.requestId, false);
    headers.set("Set-Cookie", serializeExpiredSessionCookie());
    response = new Response(null, { status: 204, headers });
    break;
  }
  case "status":
    response = success(api.status(context.activity), context.requestId);
    break;
  case "usage":
    response = success(await api.usage(parseUsageQuery(url, nowMs()), context.signal), context.requestId);
    break;
  case "accounts":
    response = success(api.accounts(), context.requestId);
    break;
  case "deviceStart": {
    const value = checked(DeviceFlowStartSchema, body);
    response = success(await api.startDeviceFlow(value.host, context.signal), context.requestId, 201);
    break;
  }
  case "devicePoll":
    response = success(await api.pollDeviceFlow(route.parameter, context.signal), context.requestId);
    break;
  case "accountDelete": {
    const value = checked(ExpectedRevisionSchema, body);
    response = success(await api.removeAccount(route.parameter, value.expectedRevision, context.signal), context.requestId);
    break;
  }
  case "accountDefault": {
    const value = checked(DefaultAccountSchema, body);
    response = success(await api.useDefaultAccount(value.accountId, value.expectedRevision, context.signal), context.requestId);
    break;
  }
  case "models":
    response = success(await api.models(optionalQuery(url, "accountId"), context.signal), context.requestId);
    break;
  case "modelsRefresh": {
    const value = checked(RefreshModelsSchema, body);
    response = success(await api.refreshModels(value.accountId, context.signal), context.requestId);
    break;
  }
  case "modelsPreferred": {
    const value = checked(PreferredModelSchema, body);
    response = success(await api.setPreferredModel(value.accountId, value.modelId, value.expectedRevision, context.signal), context.requestId);
    break;
  }
  case "modelsCapabilitiesPut": {
    const value = checked(ModelCapabilitiesSchema, body);
    response = success(await api.setModelCapabilities(
      value.accountId,
      value.modelId,
      value.expectedRevision,
      value.capabilities,
      context.signal,
    ), context.requestId);
    break;
  }
  case "modelsCapabilitiesDelete": {
    const value = checked(ModelCapabilitiesResetSchema, body);
    response = success(await api.resetModelCapabilities(
      value.accountId,
      value.modelId,
      value.expectedRevision,
      context.signal,
    ), context.requestId);
    break;
  }
  case "configGet":
    response = success(api.runtimeConfig(), context.requestId);
    break;
  case "configPut": {
    const value = checked(RuntimeConfigUpdateSchema, body);
    response = success(api.updateRuntimeConfig(value.config, value.expectedRevision, context.signal), context.requestId);
    break;
  }
  case "historyGet":
    response = success(api.history(), context.requestId);
    break;
  case "historyDelete": {
    const value = checked(ExpectedRevisionSchema, body);
    response = success(api.clearHistory(value.expectedRevision, context.signal), context.requestId);
    break;
  }
  case "events":
    response = success(await api.events(parseEventQuery(url), context.signal), context.requestId);
    break;
  case "eventStream":
    response = await events.open(
      request.headers.get("last-event-id"),
      context.signal,
      context.activity,
      (listener) => auth.watchSession(session.sessionId, listener),
    );
    response.headers.set("x-request-id", context.requestId);
    break;
  default:
    throw new AdminApiError("not_found");
  }
  context.signal.throwIfAborted();
  return response;
}

type RouteId = "bootstrap" | "session" | "logout" | "status" | "usage" | "accounts" | "deviceStart"
  | "devicePoll" | "accountDelete" | "accountDefault" | "models" | "modelsRefresh" | "modelsPreferred"
  | "modelsCapabilitiesPut" | "modelsCapabilitiesDelete"
  | "configGet" | "configPut" | "historyGet" | "historyDelete" | "events" | "eventStream";

interface MatchedRoute {
  readonly id: RouteId;
  readonly body: boolean;
  readonly mutation: boolean;
  readonly query: ReadonlySet<string>;
  readonly parameter: string;
}

function matchRoute(method: string, pathname: string): MatchedRoute | null {
  const exact = ROUTES.get(`${method} ${pathname}`);
  if (exact !== undefined) {
    return { ...exact, parameter: "" };
  }
  const device = /^\/admin\/api\/v1\/device-flows\/([^/]+)$/u.exec(pathname);
  if (method === "GET" && device?.[1] !== undefined) {
    return parameterRoute("devicePoll", device[1], false);
  }
  const account = /^\/admin\/api\/v1\/accounts\/(.+)$/u.exec(pathname);
  if (method === "DELETE" && account?.[1] !== undefined) {
    return parameterRoute("accountDelete", account[1], true);
  }
  return null;
}

function parameterRoute(id: "devicePoll" | "accountDelete", encoded: string, body: boolean): MatchedRoute {
  let parameter: string;
  try {
    parameter = decodeURIComponent(encoded);
  } catch {
    throw new AdminApiError("validation_failed");
  }
  if (parameter.length === 0) {
    throw new AdminApiError("validation_failed");
  }
  return { id, body, mutation: id === "accountDelete", query: new Set(), parameter };
}

const ROUTES = new Map<string, Omit<MatchedRoute, "parameter">>([
  route("POST", "/admin/api/v1/auth/bootstrap", "bootstrap", true, true),
  route("GET", "/admin/api/v1/auth/session", "session"),
  route("POST", "/admin/api/v1/auth/logout", "logout", false, true),
  route("GET", "/admin/api/v1/status", "status"),
  route("GET", "/admin/api/v1/usage", "usage", false, false, ["from", "to", "limit", "cursor", "accountId", "protocol", "resolvedModel", "outcome"]),
  route("GET", "/admin/api/v1/accounts", "accounts"),
  route("POST", "/admin/api/v1/device-flows", "deviceStart", true, true),
  route("PUT", "/admin/api/v1/accounts/default", "accountDefault", true, true),
  route("GET", "/admin/api/v1/models", "models", false, false, ["accountId"]),
  route("POST", "/admin/api/v1/models/refresh", "modelsRefresh", true, true),
  route("PUT", "/admin/api/v1/models/preferred", "modelsPreferred", true, true),
  route("PUT", "/admin/api/v1/models/capabilities", "modelsCapabilitiesPut", true, true),
  route("DELETE", "/admin/api/v1/models/capabilities", "modelsCapabilitiesDelete", true, true),
  route("GET", "/admin/api/v1/config", "configGet"),
  route("PUT", "/admin/api/v1/config", "configPut", true, true),
  route("GET", "/admin/api/v1/history", "historyGet"),
  route("DELETE", "/admin/api/v1/history", "historyDelete", true, true),
  route("GET", "/admin/api/v1/events", "events", false, false, ["from", "to", "limit", "cursor", "kind", "severity"]),
  route("GET", "/admin/api/v1/events/stream", "eventStream"),
]);

function route(
  method: string,
  path: string,
  id: RouteId,
  body = false,
  mutation = false,
  query: readonly string[] = [],
): [string, Omit<MatchedRoute, "parameter">] {
  return [`${method} ${path}`, { id, body, mutation, query: new Set(query) }];
}

async function readJsonObject(request: Request, limit: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  validateJsonMedia(request.headers);
  const bytes = await readBoundedBody(request, limit, signal);
  if (bytes.byteLength === 0) {
    throw new AdminApiError("validation_failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new AdminApiError("validation_failed");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AdminApiError("validation_failed");
  }
  return parsed as Record<string, unknown>;
}

async function requireNoBody(request: Request, signal: AbortSignal): Promise<void> {
  const reader = request.body?.getReader();
  if (reader === undefined) {
    return;
  }
  const onAbort = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) {
        return;
      }
      if (next.value.byteLength > 0) {
        await reader.cancel().catch(() => undefined);
        throw new AdminApiError("validation_failed");
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

async function readBoundedBody(request: Request, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (reader === undefined) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const onAbort = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) {
        break;
      }
      if (next.value.byteLength > limit - length) {
        await reader.cancel().catch(() => undefined);
        throw new AdminApiError("validation_failed");
      }
      chunks.push(next.value);
      length += next.value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function validateJsonMedia(headers: Headers): void {
  const contentType = headers.get("content-type");
  if (contentType === null || !isJsonContentType(contentType)) {
    throw new AdminApiError("validation_failed");
  }
  const encoding = headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    throw new AdminApiError("validation_failed");
  }
}

function isJsonContentType(value: string): boolean {
  const parts = value.split(";").map((part) => part.trim());
  if (parts.shift()?.toLowerCase() !== "application/json") {
    return false;
  }
  if (parts.length === 0) {
    return true;
  }
  if (parts.length !== 1) {
    return false;
  }
  const match = /^charset\s*=\s*(?:"utf-8"|utf-8)$/iu.exec(parts[0] ?? "");
  return match !== null;
}

function checked<Schema extends TSchema>(schema: Schema, value: unknown): Static<Schema> {
  if (!Value.Check(schema, value)) {
    throw new AdminApiError("validation_failed");
  }
  return structuredClone(value) as Static<Schema>;
}

function rejectQuery(url: URL, allowed: ReadonlySet<string>): void {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || seen.has(key)) {
      throw new AdminApiError("validation_failed");
    }
    seen.add(key);
  }
}

function optionalQuery(url: URL, key: string): string | null {
  const value = url.searchParams.get(key);
  if (value !== null && value.length === 0) {
    throw new AdminApiError("validation_failed");
  }
  return value;
}

function parseUsageQuery(url: URL, now: number): AdminUsageQuery {
  const fromMs = parseUtc(url, "from") ?? now - 86_400_000;
  const toMs = parseUtc(url, "to") ?? now;
  if (fromMs >= toMs || fromMs < now - 90 * 86_400_000 || toMs > now) {
    throw new AdminApiError("validation_failed");
  }
  const accountId = optionalQuery(url, "accountId");
  const protocol = setQuery(url, "protocol", PROTOCOLS);
  const resolvedModel = optionalQuery(url, "resolvedModel");
  const outcome = setQuery(url, "outcome", OUTCOMES);
  return {
    fromMs,
    toMs,
    limit: parseLimit(url),
    cursor: parseCursor(url),
    ...(accountId === null ? {} : { accountId }),
    ...(protocol === null ? {} : { protocol: protocol as Exclude<AdminUsageQuery["protocol"], undefined> }),
    ...(resolvedModel === null ? {} : { resolvedModel }),
    ...(outcome === null ? {} : { outcome: outcome as Exclude<AdminUsageQuery["outcome"], undefined> }),
  };
}

function parseEventQuery(url: URL): AdminEventQuery {
  const fromMs = parseUtc(url, "from");
  const toMs = parseUtc(url, "to");
  if (fromMs !== null && toMs !== null && fromMs >= toMs) {
    throw new AdminApiError("validation_failed");
  }
  const kind = setQuery(url, "kind", EVENT_KINDS);
  const severity = setQuery(url, "severity", SEVERITIES);
  return {
    fromMs,
    toMs,
    limit: parseLimit(url),
    cursor: parseCursor(url),
    ...(kind === null ? {} : { kind: kind as Exclude<AdminEventQuery["kind"], undefined> }),
    ...(severity === null ? {} : { severity: severity as Exclude<AdminEventQuery["severity"], undefined> }),
  };
}

function parseUtc(url: URL, key: string): number | null {
  const value = url.searchParams.get(key);
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!value.endsWith("Z") || !Number.isFinite(parsed)) {
    throw new AdminApiError("validation_failed");
  }
  return parsed;
}

function parseLimit(url: URL): number {
  const value = url.searchParams.get("limit");
  if (value === null) {
    return 100;
  }
  if (!/^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$/u.test(value)) {
    throw new AdminApiError("validation_failed");
  }
  return Number(value);
}

function parseCursor(url: URL): string | null {
  const value = url.searchParams.get("cursor");
  if (value !== null && (value.length === 0 || value.length > 16_384)) {
    throw new AdminApiError("validation_failed");
  }
  return value;
}

function setQuery(url: URL, key: string, allowed: ReadonlySet<string>): string | null {
  const value = url.searchParams.get(key);
  if (value !== null && !allowed.has(value)) {
    throw new AdminApiError("validation_failed");
  }
  return value;
}

function requireOrigin(headers: Headers, origin: string): void {
  if (headers.get("origin") !== origin) {
    throw new AdminApiError("forbidden");
  }
}

function mapRouteError(error: unknown): AdminApiError {
  if (error instanceof AdminAuthError) {
    return new AdminApiError(error.code === "capacity" ? "capacity_exceeded" : "unauthenticated");
  }
  return mapAdminError(error);
}

function success(data: unknown, requestId: string, status = 200): Response {
  return json(status, { data }, responseHeaders(requestId));
}

function failure(error: AdminApiError, requestId: string): Response {
  return json(statusFor(error.code), {
    error: { code: error.code, message: error.code.replaceAll("_", " "), requestId },
  }, responseHeaders(requestId));
}

function statusFor(code: AdminApiError["code"]): number {
  return {
    validation_failed: 400,
    unauthenticated: 401,
    forbidden: 403,
    not_found: 404,
    revision_conflict: 409,
    capacity_exceeded: 503,
    internal_error: 500,
  }[code];
}

function responseHeaders(requestId: string, jsonContent = true): Headers {
  const headers = new Headers({ "Cache-Control": "no-store", "x-request-id": requestId });
  if (jsonContent) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return headers;
}

function json(status: number, body: unknown, headers: Headers): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
