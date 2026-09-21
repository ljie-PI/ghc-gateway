import { describe, expect, it, vi } from "vitest";
import type { LoopbackOrigin } from "../../src/gateway/create_gateway.js";
import { CliError, type ControlOperation, type ControlOperationMap } from "../../src/cli/control_client.js";
import {
  createLocalControlModule,
  type LocalControlIdentity,
  type LocalControlCommandDispatcher,
} from "../../src/daemon/local_control.js";

const ORIGIN: LoopbackOrigin = "http://127.0.0.1:31400";
const CONTROL = `${ORIGIN}/__ghcg/control/v1`;
const BODY_LIMIT = 1_048_576;
const identity: LocalControlIdentity = Object.freeze({
  managed: true,
  pid: 123,
  processStartIdentity: "windows-filetime-133801632000000000",
  instanceNonce: "instance-nonce",
  controlToken: "control-token",
});

describe("LocalControlModule", () => {
  it("owns only the three exact route and method pairs", async () => {
    const { control } = harness();

    expect((await handle(control, "GET", "/status")).status).toBe(200);
    expect((await handle(control, "POST", "/stop")).status).toBe(202);
    expect((await handle(control, "POST", "/command", commandBody("accounts.list", {}))).status).toBe(200);

    for (const [method, path] of [
      ["POST", "/status"],
      ["GET", "/stop"],
      ["POST", "/admin-bootstrap"],
      ["GET", "/admin-bootstrap"],
      ["GET", "/command"],
      ["GET", "/status/"],
      ["GET", "/missing"],
    ] as const) {
      const response = await handle(control, method, path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: "not_found", message: "not found" } });
    }
  });

  it("requires exact control token and instance nonce before any action", async () => {
    const fixture = harness();
    const missing = await handle(fixture.control, "GET", "/status", undefined, {});
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: { code: "unauthorized", message: "unauthorized" } });

    const wrongToken = await handle(fixture.control, "GET", "/status", undefined, {
      "x-ghcg-control-token": "wrong",
      "x-ghcg-instance-nonce": identity.instanceNonce,
    });
    expect(wrongToken.status).toBe(401);

    const wrongNonce = await handle(fixture.control, "GET", "/status", undefined, {
      "x-ghcg-control-token": identity.controlToken,
      "x-ghcg-instance-nonce": "wrong",
    });
    expect(wrongNonce.status).toBe(409);
    expect(await wrongNonce.json()).toEqual({ error: { code: "instance_mismatch", message: "instance mismatch" } });
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(fixture.dispatcher.calls).toEqual([]);
  });

  it("returns the immutable identity tuple for status and accepted stop", async () => {
    const fixture = harness();
    const status = await handle(fixture.control, "GET", "/status");
    expect(await status.json()).toEqual({
      data: {
        state: "running",
        instance: {
          pid: 123,
          processStartIdentity: "windows-filetime-133801632000000000",
          instanceNonce: "instance-nonce",
        },
      },
    });

    const stopped = await handle(fixture.control, "POST", "/stop");
    expect(stopped.status).toBe(202);
    expect(await stopped.json()).toEqual({
      data: {
        instance: {
          pid: 123,
          processStartIdentity: "windows-filetime-133801632000000000",
          instanceNonce: "instance-nonce",
        },
      },
    });
    expect(fixture.stop).toHaveBeenCalledOnce();
    expect(fixture.stop.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it("rejects authenticated stop for a foreground instance without requesting shutdown", async () => {
    const fixture = harness({ identity: { ...identity, managed: false } });
    const response = await handle(fixture.control, "POST", "/stop");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "instance_mismatch", message: "instance mismatch" } });
    expect(fixture.stop).not.toHaveBeenCalled();
  });

  it("validates the command object and operation arguments with TypeBox without coercion", async () => {
    const fixture = harness();
    const invalid = [
      "",
      "{",
      "[]",
      JSON.stringify({ operation: "accounts.list" }),
      JSON.stringify({ operation: "unknown", arguments: {} }),
      JSON.stringify({ operation: "accounts.list", arguments: { extra: true } }),
      JSON.stringify({ operation: "accounts.use", arguments: { accountId: 42 } }),
      JSON.stringify({ operation: "config.set", arguments: { key: "admission.activeMax", value: 2 } }),
      JSON.stringify({ operation: "accounts.list", arguments: {}, extra: true }),
    ];
    for (const body of invalid) {
      const response = await handle(fixture.control, "POST", "/command", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "invalid_command", message: "invalid command" } });
    }
    expect(fixture.dispatcher.calls).toEqual([]);

    const response = await handle(fixture.control, "POST", "/command", commandBody("config.set", {
      key: "admission.activeMax",
      value: "2",
    }));
    expect(await response.json()).toEqual({ data: { operation: "config.set", arguments: { key: "admission.activeMax", value: "2" } } });
    expect(fixture.dispatcher.calls[0]).toMatchObject({ operation: "config.set", args: { key: "admission.activeMax", value: "2" } });
  });

  it("enforces the fixed 1 MiB command cap and cancels at the first excess byte", async () => {
    const fixture = harness();
    const prefix = "{\"operation\":\"auth.login.start\",\"arguments\":{\"host\":\"";
    const suffix = "\"}}";
    const atLimit = `${prefix}${"x".repeat(BODY_LIMIT - prefix.length - suffix.length)}${suffix}`;
    expect(new TextEncoder().encode(atLimit)).toHaveLength(BODY_LIMIT);
    expect((await handle(fixture.control, "POST", "/command", atLimit)).status).toBe(200);

    let cancelled = false;
    const bytes = new TextEncoder().encode(`${atLimit} `);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, BODY_LIMIT));
        controller.enqueue(bytes.subarray(BODY_LIMIT));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await handleStream(fixture.control, "/command", stream);
    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(fixture.dispatcher.calls).toHaveLength(1);
  });

  it("rejects nonempty bodies on no-body routes and cancels their readers", async () => {
    const fixture = harness();
    for (const [method, path] of [["GET", "/status"], ["POST", "/stop"]] as const) {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      });
      const response = await handleStream(fixture.control, path, stream, method);
      expect(response.status).toBe(400);
      expect(cancelled).toBe(true);
    }
    expect(fixture.stop).not.toHaveBeenCalled();
  });

  it("returns safe application error categories and uniform response headers", async () => {
    const fixture = harness();
    fixture.dispatcher.failures.push(new CliError("revision_conflict"), new Error("secret request content"));

    const conflict = await handle(fixture.control, "POST", "/command", commandBody("accounts.list", {}));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: "revision_conflict", message: "revision conflict" } });
    expect(conflict.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(conflict.headers.get("cache-control")).toBe("no-store");
    expect(conflict.headers.get("x-request-id")).toBe("req_control");

    const internal = await handle(fixture.control, "POST", "/command", commandBody("accounts.list", {}));
    expect(internal.status).toBe(500);
    expect(await internal.text()).toBe(JSON.stringify({ error: { code: "internal_error", message: "internal error" } }));

    const success = await handle(fixture.control, "GET", "/status");
    expect(success.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(success.headers.get("cache-control")).toBe("no-store");
    expect(success.headers.get("x-request-id")).toBe("req_control");
  });

  it("propagates caller and close abort, emits an empty response, and closes idempotently", async () => {
    const signals: AbortSignal[] = [];
    const dispatcher: LocalControlCommandDispatcher = {
      async dispatch(_operation, _args, signal) {
        signals.push(signal);
        return await new Promise<never>(() => undefined);
      },
    };
    const first = harness({ dispatcher });
    const caller = new AbortController();
    const callerWork = handle(first.control, "POST", "/command", commandBody("accounts.list", {}), undefined, caller.signal);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    caller.abort();
    expect(await (await settlesSoon(callerWork)).text()).toBe("");
    expect(signals[0]?.aborted).toBe(true);

    const second = harness({ dispatcher });
    const closeWork = handle(second.control, "POST", "/command", commandBody("accounts.list", {}));
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    second.control.close();
    second.control.close();
    expect(await (await settlesSoon(closeWork)).text()).toBe("");
    expect(signals[1]?.aborted).toBe(true);
    const closed = await handle(second.control, "GET", "/status");
    expect(closed.status).toBe(503);
    expect(await closed.json()).toEqual({ error: { code: "not_ready", message: "not ready" } });
  });
});

class ScriptedDispatcher implements LocalControlCommandDispatcher {
  readonly calls: Array<{ readonly operation: ControlOperation; readonly args: unknown; readonly signal: AbortSignal }> = [];
  readonly failures: unknown[] = [];

  async dispatch<Operation extends ControlOperation>(
    operation: Operation,
    args: ControlOperationMap[Operation]["args"],
    signal: AbortSignal,
  ): Promise<ControlOperationMap[Operation]["result"]> {
    this.calls.push({ operation, args, signal });
    const failure = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    return { operation, arguments: args } as unknown as ControlOperationMap[Operation]["result"];
  }
}

function harness(options: {
  readonly dispatcher?: LocalControlCommandDispatcher;
  readonly identity?: LocalControlIdentity;
} = {}) {
  const dispatcher = options.dispatcher ?? new ScriptedDispatcher();
  const stop = vi.fn(async (_signal: AbortSignal) => undefined);
  const control = createLocalControlModule({ identity: options.identity ?? identity, dispatcher, requestStop: stop });
  return { control, dispatcher: dispatcher as ScriptedDispatcher, stop };
}

function commandBody<Operation extends ControlOperation>(operation: Operation, args: ControlOperationMap[Operation]["args"]): string {
  return JSON.stringify({ operation, arguments: args });
}

async function handle(
  control: ReturnType<typeof createLocalControlModule>,
  method: string,
  path: string,
  body?: string,
  headers: HeadersInit = authenticatedHeaders(),
  signal?: AbortSignal,
): Promise<Response> {
  return await control.handle(new Request(`${CONTROL}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body }),
    ...(signal === undefined ? {} : { signal }),
  }), { requestId: "req_control", signal: signal ?? new AbortController().signal, listenerOrigin: ORIGIN });
}

interface StreamingRequestInit extends RequestInit {
  readonly duplex: "half";
}

async function handleStream(
  control: ReturnType<typeof createLocalControlModule>,
  path: string,
  body: ReadableStream<Uint8Array>,
  method = "POST",
): Promise<Response> {
  const init: StreamingRequestInit = {
    method: method === "GET" ? "POST" : method,
    headers: { ...authenticatedHeaders(), "content-type": "application/json" },
    body,
    duplex: "half",
  };
  const request = new Request(`${CONTROL}${path}`, init);
  if (method === "GET") {
    Object.defineProperty(request, "method", { value: method });
  }
  return await control.handle(request, {
    requestId: "req_control",
    signal: new AbortController().signal,
    listenerOrigin: ORIGIN,
  });
}

function authenticatedHeaders(): Record<string, string> {
  return {
    "x-ghcg-control-token": identity.controlToken,
    "x-ghcg-instance-nonce": identity.instanceNonce,
  };
}

async function settlesSoon<T>(work: Promise<T>): Promise<T> {
  return await Promise.race([
    work,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("work did not abort")), 100)),
  ]);
}
