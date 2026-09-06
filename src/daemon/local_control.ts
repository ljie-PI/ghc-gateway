import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ControlOperation, ControlOperationMap, CliErrorCode } from "../cli/control_client.js";
import { CliError, SAFE_ERROR_MESSAGES } from "../cli/control_client.js";
import type { AdminModule, LocalControlModule } from "../gateway/create_gateway.js";

const CONTROL_PREFIX = "/__ghcg/control/v1";
const COMMAND_BODY_LIMIT = 1_048_576;

const EmptyArgumentsSchema = Type.Object({}, { additionalProperties: false });
const OptionalAccountSchema = Type.Object({
  accountId: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });
const AccountSchema = Type.Object({
  accountId: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const ControlCommandSchema = Type.Union([
  commandSchema("auth.login.start", Type.Object({
    host: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false })),
  commandSchema("auth.login.poll", Type.Object({
    flowId: Type.String({ minLength: 1 }),
  }, { additionalProperties: false })),
  commandSchema("auth.login.cancel", Type.Object({
    flowId: Type.String({ minLength: 1 }),
  }, { additionalProperties: false })),
  commandSchema("auth.logout", OptionalAccountSchema),
  commandSchema("auth.status", EmptyArgumentsSchema),
  commandSchema("accounts.list", EmptyArgumentsSchema),
  commandSchema("accounts.use", AccountSchema),
  commandSchema("accounts.remove", AccountSchema),
  commandSchema("models.list", OptionalAccountSchema),
  commandSchema("models.current", EmptyArgumentsSchema),
  commandSchema("models.set", Type.Object({
    modelId: Type.String({ minLength: 1 }),
  }, { additionalProperties: false })),
  commandSchema("config.get", Type.Object({
    key: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false })),
  commandSchema("config.set", Type.Object({
    key: Type.String({ minLength: 1 }),
    value: Type.String({ minLength: 1 }),
  }, { additionalProperties: false })),
]);

type ControlCommand = Static<typeof ControlCommandSchema>;

export interface LocalControlIdentity {
  readonly managed: boolean;
  readonly pid: number;
  readonly processStartIdentity: string;
  readonly instanceNonce: string;
  readonly controlToken: string;
}

export interface LocalControlCommandDispatcher {
  dispatch<Operation extends ControlOperation>(
    operation: Operation,
    args: ControlOperationMap[Operation]["args"],
    signal: AbortSignal,
  ): Promise<ControlOperationMap[Operation]["result"]>;
}

export interface LocalControlDependencies {
  readonly identity: Readonly<LocalControlIdentity>;
  readonly admin: AdminModule;
  readonly dispatcher: LocalControlCommandDispatcher;
  readonly requestStop: (signal: AbortSignal) => Promise<void> | void;
}

type ControlFailureCode =
  | "not_found"
  | "unauthorized"
  | "instance_mismatch"
  | "not_ready"
  | "invalid_command"
  | CliErrorCode;

class ControlFailure extends Error {
  constructor(readonly code: ControlFailureCode) {
    super(code);
    this.name = "ControlFailure";
  }
}

export function createLocalControlModule(
  dependencies: Readonly<LocalControlDependencies>,
): LocalControlModule {
  const identity = Object.freeze({
    pid: dependencies.identity.pid,
    managed: dependencies.identity.managed,
    processStartIdentity: dependencies.identity.processStartIdentity,
    instanceNonce: dependencies.identity.instanceNonce,
    controlToken: dependencies.identity.controlToken,
  });
  const instance = Object.freeze({
    pid: identity.pid,
    processStartIdentity: identity.processStartIdentity,
    instanceNonce: identity.instanceNonce,
  });
  const closing = new AbortController();
  let closed = false;

  return {
    async handle(request, context) {
      if (closed) {
        return failure("not_ready", context.requestId);
      }
      const signal = AbortSignal.any([request.signal, context.signal, closing.signal]);
      try {
        signal.throwIfAborted();
        const url = new URL(request.url);
        const route = matchRoute(request.method, url.pathname);
        if (route === null) {
          throw new ControlFailure("not_found");
        }
        if (url.search.length !== 0) {
          throw new ControlFailure("invalid_command");
        }
        authenticate(request.headers, identity);

        if (route === "command") {
          const command = await readCommand(request, signal);
          signal.throwIfAborted();
          const result = await withAbort(
            dependencies.dispatcher.dispatch(command.operation, command.arguments, signal),
            signal,
          );
          signal.throwIfAborted();
          return success(200, result, context.requestId);
        }

        await requireNoBody(request, signal);
        signal.throwIfAborted();
        if (route === "status") {
          return success(200, { state: "running", instance }, context.requestId);
        }
        if (route === "stop") {
          if (!identity.managed) {
            throw new ControlFailure("instance_mismatch");
          }
          await withAbort(Promise.resolve(dependencies.requestStop(signal)), signal);
          signal.throwIfAborted();
          return success(202, { instance }, context.requestId);
        }

        const bootstrap = dependencies.admin.mintBootstrap();
        if (bootstrap.kind !== "issued") {
          throw new ControlFailure("not_ready");
        }
        return success(200, { token: bootstrap.token, expiresAt: bootstrap.expiresAt }, context.requestId);
      } catch (error: unknown) {
        if (signal.aborted || isAbortError(error)) {
          return new Response(null);
        }
        if (error instanceof ControlFailure) {
          return failure(error.code, context.requestId);
        }
        if (error instanceof CliError) {
          return failure(error.code, context.requestId);
        }
        return failure("internal_error", context.requestId);
      }
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      closing.abort();
    },
  };
}

function commandSchema<Operation extends ControlOperation, Arguments extends ReturnType<typeof Type.Object>>(
  operation: Operation,
  argumentsSchema: Arguments,
) {
  return Type.Object({
    operation: Type.Literal(operation),
    arguments: argumentsSchema,
  }, { additionalProperties: false });
}

function matchRoute(method: string, path: string): "status" | "stop" | "admin-bootstrap" | "command" | null {
  if (method === "GET" && path === `${CONTROL_PREFIX}/status`) {
    return "status";
  }
  if (method === "POST" && path === `${CONTROL_PREFIX}/stop`) {
    return "stop";
  }
  if (method === "POST" && path === `${CONTROL_PREFIX}/admin-bootstrap`) {
    return "admin-bootstrap";
  }
  if (method === "POST" && path === `${CONTROL_PREFIX}/command`) {
    return "command";
  }
  return null;
}

function authenticate(headers: Headers, identity: Readonly<LocalControlIdentity>): void {
  if (headers.get("x-ghcg-control-token") !== identity.controlToken) {
    throw new ControlFailure("unauthorized");
  }
  if (headers.get("x-ghcg-instance-nonce") !== identity.instanceNonce) {
    throw new ControlFailure("instance_mismatch");
  }
}

async function readCommand(request: Request, signal: AbortSignal): Promise<ControlCommand> {
  validateJsonMedia(request.headers);
  const bytes = await readBoundedBody(request, COMMAND_BODY_LIMIT, signal);
  if (bytes.byteLength === 0) {
    throw new ControlFailure("invalid_command");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new ControlFailure("invalid_command");
  }
  if (!Value.Check(ControlCommandSchema, value)) {
    throw new ControlFailure("invalid_command");
  }
  return structuredClone(value) as ControlCommand;
}

function validateJsonMedia(headers: Headers): void {
  const contentType = headers.get("content-type");
  if (contentType === null || !isJsonContentType(contentType)) {
    throw new ControlFailure("invalid_command");
  }
  const encoding = headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    throw new ControlFailure("invalid_command");
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
  return parts.length === 1 && /^charset\s*=\s*(?:"utf-8"|utf-8)$/iu.test(parts[0] ?? "");
}

async function requireNoBody(request: Request, signal: AbortSignal): Promise<void> {
  const reader = request.body?.getReader();
  if (reader === undefined) {
    return;
  }
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const next = await readNext(reader, signal);
      if (next.done) {
        return;
      }
      if (next.value.byteLength !== 0) {
        await reader.cancel().catch(() => undefined);
        throw new ControlFailure("invalid_command");
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
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
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const next = await readNext(reader, signal);
      if (next.done) {
        break;
      }
      if (next.value.byteLength > limit - length) {
        await reader.cancel().catch(() => undefined);
        throw new ControlFailure("invalid_command");
      }
      chunks.push(next.value);
      length += next.value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
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

async function readNext(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted();
  let removeAbort = (): void => undefined;
  return await Promise.race([
    reader.read(),
    new Promise<never>((_resolve, reject) => {
      const abort = (): void => reject(new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", abort);
    }),
  ]).finally(removeAbort);
}

async function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let removeAbort = (): void => undefined;
  return await Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      const abort = (): void => reject(new DOMException("aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => signal.removeEventListener("abort", abort);
    }),
  ]).finally(removeAbort);
}

function success(status: number, data: unknown, requestId: string): Response {
  return json(status, { data }, requestId);
}

function failure(code: ControlFailureCode, requestId: string): Response {
  const normalized = failureDetails(code);
  return json(normalized.status, { error: { code: normalized.code, message: normalized.message } }, requestId);
}

function failureDetails(code: ControlFailureCode): { readonly status: number; readonly code: string; readonly message: string } {
  if (code === "not_found") {
    return { status: 404, code, message: "not found" };
  }
  if (code === "unauthorized") {
    return { status: 401, code, message: "unauthorized" };
  }
  if (code === "instance_mismatch") {
    return { status: 409, code, message: "instance mismatch" };
  }
  if (code === "not_ready") {
    return { status: 503, code, message: "not ready" };
  }
  if (code === "invalid_command") {
    return { status: 400, code, message: "invalid command" };
  }
  return { status: cliStatus(code), code, message: SAFE_ERROR_MESSAGES[code] };
}

function cliStatus(code: CliErrorCode): number {
  switch (code) {
  case "usage_error":
  case "unsupported_runtime":
  case "validation_error":
    return 400;
  case "not_found":
    return 404;
  case "revision_conflict":
  case "daemon_stale":
  case "daemon_conflict":
    return 409;
  case "permission_denied":
  case "security_error":
    return 403;
  case "timeout":
    return 504;
  case "unavailable":
  case "daemon_unreachable":
    return 503;
  case "remote_error":
  case "authorization_expired":
  case "authorization_denied":
  case "authorization_failed":
    return 502;
  case "internal_error":
  case "interrupted":
    return 500;
  }
}

function json(status: number, body: unknown, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "x-request-id": requestId,
    },
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
