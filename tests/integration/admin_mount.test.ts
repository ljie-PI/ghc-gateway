import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import {
  createGateway,
  type AdminModule,
  type AdminRequestContext,
  type AdminStaticModule,
  type LocalControlModule,
} from "../../src/gateway/create_gateway.js";
import type { RouteRegistration } from "../../src/gateway/hono_app.js";

const textRoute = (path: string, body: string): RouteRegistration => ({
  method: "GET",
  path,
  admission: "none",
  body: "none",
  presentFailure: () => new Response("protocol failure", { status: 500 }),
  endpoint: async () => new Response(body),
});

function startup(port = 31400) {
  return parseStartupConfig(["--port", String(port)], {}, { homedir: "Q:/tmp/admin-mount" });
}

describe("additive Gateway mount", () => {
  afterEach(() => vi.useRealTimers());
  it("uses control, Admin API, protocol/probe, then Admin static precedence", async () => {
    const calls: string[] = [];
    const contexts: AdminRequestContext[] = [];
    const admin: AdminModule = {
      async handle(request, context) {
        calls.push(`admin:${new URL(request.url).pathname}`);
        contexts.push(context);
        return new Response(JSON.stringify({ error: { code: "not_found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      },
      close() {},
    };
    const control: LocalControlModule = {
      async handle(request, context) {
        calls.push(`control:${new URL(request.url).pathname}:${context.requestId}:${context.listenerOrigin}`);
        return new Response("control");
      },
      close() {},
    };
    const adminStatic: AdminStaticModule = {
      async handle(request) {
        const pathname = new URL(request.url).pathname;
        calls.push(`static:${pathname}`);
        if (pathname === "/" || pathname === "/assets/app.js") {
          return new Response("static");
        }
        return new Response("404 Not Found", { status: 404 });
      },
    };
    let nextId = 0;
    const gateway = await createGateway({
      startup: startup(32123),
      runtime: defaultRuntimeConfigSnapshot(),
    }, [
      textRoute("/admin/api/v1/status", "protocol"),
      textRoute("/v1/example", "protocol"),
      textRoute("/assets/protocol.js", "protocol asset"),
    ], {
      admin,
      control,
      adminStatic,
      createRequestId: () => `req_mount_${++nextId}`,
    });

    expect(await (await gateway.fetch(new Request("http://127.0.0.1:32123/__ghcg/control/v1/status"))).text()).toBe("control");
    const unknownAdmin = await gateway.fetch(new Request("http://127.0.0.1:32123/admin/api/v1/missing", {
      headers: { "x-request-id": "caller-id" },
    }));
    expect(unknownAdmin.status).toBe(404);
    expect(await unknownAdmin.json()).toEqual({ error: { code: "not_found" } });
    expect(await (await gateway.fetch(new Request("http://127.0.0.1:32123/v1/example"))).text()).toBe("protocol");
    expect((await gateway.fetch(new Request("http://127.0.0.1:32123/healthz"))).status).toBe(200);
    expect(await (await gateway.fetch(new Request("http://127.0.0.1:32123/assets/protocol.js"))).text()).toBe("protocol asset");
    expect(await (await gateway.fetch(new Request("http://127.0.0.1:32123/"))).text()).toBe("static");
    expect(await (await gateway.fetch(new Request("http://127.0.0.1:32123/assets/app.js"))).text()).toBe("static");
    for (const pathname of [
      "/admin",
      "/admin/",
      "/admin/dashboard",
      "/admin/api/v10",
      "/v1/missing",
      "/healthz/missing",
      "/readyz/missing",
      "/__ghcg/missing",
      "/assets",
      "/assets/",
      "/assets/missing.js",
      "/unknown",
    ]) {
      const response = await gateway.fetch(new Request(`http://127.0.0.1:32123${pathname}`));
      expect(response.status, pathname).toBe(404);
      expect(response.headers.get("content-type"), pathname).not.toContain("text/html");
    }
    expect((await gateway.fetch(new Request("http://127.0.0.1:32123/", { method: "POST" }))).status).toBe(404);

    expect(calls).toEqual([
      "control:/__ghcg/control/v1/status:req_mount_1:http://127.0.0.1:32123",
      "admin:/admin/api/v1/missing",
      "static:/",
      "static:/assets/app.js",
      "static:/assets",
      "static:/assets/",
      "static:/assets/missing.js",
    ]);
    expect(contexts[0]?.requestId).toBe("req_mount_2");
    expect(contexts[0]?.listenerOrigin).toBe("http://127.0.0.1:32123");
    expect(contexts[0]?.signal.aborted).toBe(false);
    await gateway.close();

    const staticOnly = await createGateway({ startup: startup(), runtime: defaultRuntimeConfigSnapshot() }, [], {
      adminStatic,
    });
    expect((await staticOnly.fetch(new Request("http://127.0.0.1:31400/admin/api/v1/missing"))).status).toBe(404);
    expect(calls).not.toContain("static:/admin/api/v1/missing");
    expect(await (await staticOnly.fetch(new Request("http://127.0.0.1:31400/"))).text()).toBe("static");
    await staticOnly.close();
  });

  it("combines caller and Gateway shutdown cancellation for mounted work", async () => {
    const signals: AbortSignal[] = [];
    const started: Array<() => void> = [];
    const admin: AdminModule = {
      async handle(_request, context) {
        signals.push(context.signal);
        started.shift()?.();
        await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
        return new Response(null);
      },
      close() {},
    };
    const gateway = await createGateway({ startup: startup(), runtime: defaultRuntimeConfigSnapshot() }, [], { admin });

    const caller = new AbortController();
    const callerStarted = new Promise<void>((resolve) => started.push(resolve));
    const callerRequest = gateway.fetch(new Request("http://127.0.0.1:31400/admin/api/v1/status", { signal: caller.signal }));
    await callerStarted;
    caller.abort();
    await callerRequest;
    expect(signals[0]?.aborted).toBe(true);

    const shutdownStarted = new Promise<void>((resolve) => started.push(resolve));
    const shutdownRequest = gateway.fetch(new Request("http://127.0.0.1:31400/admin/api/v1/status"));
    await shutdownStarted;
    await gateway.close();
    await shutdownRequest;
    expect(signals[1]?.aborted).toBe(true);
  });

  it("reports admission and active stream lifecycle through GatewayActivity", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.admission.activeMax = 1;
    runtime.admission.queueMax = 1;
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const route: RouteRegistration = {
      method: "GET",
      path: "/v1/stream",
      admission: "inference",
      body: "none",
      presentFailure: () => new Response("failure", { status: 503 }),
      endpoint: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller);
        },
      }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }),
    };
    const admin: AdminModule = {
      async handle(_request, context) {
        return Response.json(context.activity.snapshot());
      },
      close() {},
    };
    const gateway = await createGateway({ startup: startup(), runtime }, [route], { admin });

    const first = await gateway.fetch(new Request("http://127.0.0.1:31400/v1/stream"));
    const secondPromise = gateway.fetch(new Request("http://127.0.0.1:31400/v1/stream"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await (await gateway.fetch(new Request("http://127.0.0.1:31400/admin/api/v1/status"))).json()).toEqual({
      activeRequests: 1,
      activeStreams: 1,
      queuedRequests: 1,
    });

    streams[0]?.close();
    await first.arrayBuffer();
    const second = await secondPromise;
    expect(await (await gateway.fetch(new Request("http://127.0.0.1:31400/admin/api/v1/status"))).json()).toEqual({
      activeRequests: 1,
      activeStreams: 1,
      queuedRequests: 0,
    });
    streams[1]?.close();
    await second.arrayBuffer();
    expect(await (await gateway.fetch(new Request("http://127.0.0.1:31400/admin/api/v1/status"))).json()).toEqual({
      activeRequests: 0,
      activeStreams: 0,
      queuedRequests: 0,
    });
    await gateway.close();
  });

  it("closes control, Admin, then existing resources exactly once", async () => {
    const order: string[] = [];
    const admin: AdminModule = {
      handle: async () => new Response(null),
      close: () => order.push("admin"),
    };
    const control: LocalControlModule = {
      handle: async () => new Response(null),
      close: () => order.push("control"),
    };
    const gateway = await createGateway({ startup: startup(), runtime: defaultRuntimeConfigSnapshot() }, [], {
      admin,
      control,
      onClose: () => {
        order.push("onClose");
      },
    });

    await gateway.close();
    await gateway.close();
    expect(order).toEqual(["control", "admin", "onClose"]);
  });

  it("forces remaining resources closed when graceful cleanup rejects", async () => {
    const calls: string[] = [];
    const gateway = await createGateway({ startup: startup(), runtime: defaultRuntimeConfigSnapshot() }, [], {
      onClose: () => { throw new Error("close failed"); },
      onForceClose: () => { calls.push("forced"); },
    });
    await expect(gateway.close()).rejects.toThrow("close failed");
    expect(calls).toEqual(["forced"]);
  });

  it("forces listener and resource closure after the bounded 10 second grace period", async () => {
    vi.useFakeTimers();
    const server = {
      listening: true,
      once() { return this; },
      off() { return this; },
      close: vi.fn(),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    const forceClose = vi.fn();
    const timeout = vi.fn();
    const gateway = await createGateway({ startup: startup(), runtime: defaultRuntimeConfigSnapshot() }, [], {
      listen: () => server,
      onClose: async () => await new Promise<void>(() => undefined),
      onForceClose: forceClose,
      onShutdownTimeout: timeout,
    });
    await gateway.listen();
    const closing = gateway.close();
    expect(server.close).toHaveBeenCalledOnce();
    expect(server.closeIdleConnections).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(timeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(timeout).toHaveBeenCalledOnce();
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    expect(forceClose).toHaveBeenCalledOnce();
    await gateway.close();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("captures the current runtime config for each later protocol request", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    let current = runtime;
    const observed: number[] = [];
    const route: RouteRegistration = {
      method: "GET",
      path: "/v1/runtime",
      admission: "none",
      body: "none",
      presentFailure: () => new Response(null, { status: 500 }),
      endpoint: async (_request, scope) => {
        observed.push(scope.config.limits.requestBodyBytes);
        return new Response(null, { status: 204 });
      },
    };
    const gateway = await createGateway({ startup: startup(), runtime }, [route], {
      readRuntimeConfig: () => current,
    });

    await gateway.fetch(new Request("http://127.0.0.1:31400/v1/runtime"));
    current = structuredClone(runtime);
    current.limits.requestBodyBytes = 1_048_576;
    await gateway.fetch(new Request("http://127.0.0.1:31400/v1/runtime"));

    expect(observed).toEqual([33_554_432, 1_048_576]);
    await gateway.close();
  });

  it("closes admission before teardown can release a queued request", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.admission.activeMax = 1;
    runtime.admission.queueMax = 1;
    let starts = 0;
    let releaseFirst = (): void => undefined;
    const route: RouteRegistration = {
      method: "GET",
      path: "/v1/blocked",
      admission: "inference",
      body: "none",
      presentFailure: () => new Response(null, { status: 503 }),
      endpoint: async () => {
        starts += 1;
        if (starts === 1) {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        return new Response(null, { status: 204 });
      },
    };
    const gateway = await createGateway({ startup: startup(), runtime }, [route]);
    const first = gateway.fetch(new Request("http://127.0.0.1:31400/v1/blocked"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = gateway.fetch(new Request("http://127.0.0.1:31400/v1/blocked"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const closing = gateway.close();
    releaseFirst();
    await Promise.all([first, queued, closing]);
    expect(starts).toBe(1);
  });
});
