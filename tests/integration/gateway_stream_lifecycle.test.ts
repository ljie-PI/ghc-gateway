import { describe, expect, it } from "vitest";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { createStreamResponseWriter } from "../../src/gateway/stream_response.js";
import { armTimeout } from "../../src/gateway/timeouts.js";
import { defaultDelay } from "../../src/gateway/admission.js";
import type { RouteRegistration } from "../../src/gateway/hono_app.js";
import { createRequestAttempt } from "../../src/gateway/request_attempt.js";
import type { UsageUpdate } from "../../src/telemetry/recorder.js";

describe("stream writer", () => {
  it("is pull-based, commits on first body byte, and writes nothing after abort", async () => {
    const abort = new AbortController();
    const writer = createStreamResponseWriter({ signal: abort.signal });
    expect(writer.committed).toBe(false);

    const reader = writer.response.body?.getReader();
    expect(reader).toBeDefined();
    const first = new Uint8Array([1, 2, 3]);
    const accepted = await writer.enqueue(first);
    expect(accepted).toBe(true);
    const chunk = await reader?.read();
    expect(writer.committed).toBe(true);
    expect(chunk?.value).toEqual(first);

    abort.abort();
    const rejected = await writer.enqueue(new Uint8Array([9]));
    expect(rejected).toBe(false);
    writer.close();
  });
});

describe("stream route lifecycle", () => {
  it("does not commit headers-only construction as success body", async () => {
    const route: RouteRegistration = {
      method: "POST",
      path: "/v1/stream",
      admission: "none",
      body: "none",
      presentFailure: (failure) => new Response(JSON.stringify({ kind: failure.kind }), { status: 400 }),
      endpoint: async (_request, scope) => {
        const writer = createStreamResponseWriter({
          signal: scope.signal,
          headers: { "Content-Type": "text/event-stream" },
        });
        expect(writer.committed).toBe(false);
        queueMicrotask(() => {
          void writer.enqueue(new TextEncoder().encode("data: hi\n\n")).then(() => writer.close());
        });
        return writer.response;
      },
    };

    const gw = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: "Q:\\tmp-ghc-gateway" }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, [route]);

    const response = await gw.fetch(new Request("http://127.0.0.1:31400/v1/stream", { method: "POST" }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("data: hi\n\n");
    await gw.close();
  });

  it("arms connect/first-byte/idle/total timers from the snapshot", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    expect(runtime.timeouts.connectMs).toBe(30_000);
    expect(runtime.timeouts.firstByteMs).toBe(120_000);
    expect(runtime.timeouts.streamIdleMs).toBe(120_000);
    expect(runtime.timeouts.totalMs).toBe(1_800_000);

    const controller = new AbortController();
    let timedOut = false;
    const disarm = armTimeout(1_000, controller.signal, {
      nowMs: Date.now,
      delay: defaultDelay,
    }, () => {
      timedOut = true;
      controller.abort();
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(timedOut).toBe(true);
    disarm();
  });

  it("disarms timers and aborts in-flight work on close", async () => {
    let endpointStarted = false;
    const route: RouteRegistration = {
      method: "POST",
      path: "/v1/hold",
      admission: "inference",
      body: "none",
      presentFailure: (failure) => new Response(JSON.stringify({ kind: failure.kind }), { status: 503 }),
      endpoint: async (_request, scope) => {
        endpointStarted = true;
        await new Promise<void>((resolve) => {
          scope.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return new Response("{}");
      },
    };
    const gw = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: "Q:\\tmp-ghc-gateway" }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, [route]);
    const pending = gw.fetch(new Request("http://127.0.0.1:31400/v1/hold", { method: "POST" }));
    for (let index = 0; index < 50 && !endpointStarted; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(endpointStarted).toBe(true);
    await gw.close();
    const closed = await pending;
    expect(await closed.text()).toBe("");
    const after = await gw.fetch(new Request("http://127.0.0.1:31400/healthz"));
    expect(after.status).toBe(503);
  });

  it("does not admit or execute a request whose client signal is already aborted", async () => {
    const usage: UsageUpdate[] = [];
    let executed = false;
    const route: RouteRegistration = {
      method: "POST",
      path: "/v1/pre-aborted",
      admission: "inference",
      body: "none",
      presentFailure: () => new Response("{}"),
      createAttempt: (requestId, config) => createRequestAttempt({
        requestId,
        config,
        protocol: "openai_chat",
        recorder: { recordUsage: (update) => usage.push(update) },
        abortedErrorCount: 0,
      }),
      endpoint: async () => {
        executed = true;
        return new Response("{}");
      },
    };
    const gw = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: "Q:\\tmp-ghc-gateway" }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, [route]);
    const controller = new AbortController();
    controller.abort();
    try {
      const response = await gw.fetch(new Request("http://127.0.0.1:31400/v1/pre-aborted", {
        method: "POST",
        signal: controller.signal,
      }));
      expect(await response.text()).toBe("");
      expect(executed).toBe(false);
      expect(usage).toMatchObject([{ outcome: "aborted", errorCount: 0 }]);
    } finally {
      await gw.close();
    }
  });

  it("holds the inference slot until the stream body ends", async () => {
    const writers: ReturnType<typeof createStreamResponseWriter>[] = [];
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.admission.activeMax = 1;
    runtime.admission.queueMax = 0;
    const route: RouteRegistration = {
      method: "POST",
      path: "/v1/hold-stream",
      admission: "inference",
      body: "none",
      presentFailure: (failure) => new Response(JSON.stringify({ kind: failure.kind }), {
        status: failure.kind === "queue_full" ? 503 : 400,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      }),
      endpoint: async (_request, scope) => {
        const writer = createStreamResponseWriter({ signal: scope.signal });
        writers.push(writer);
        return writer.response;
      },
    };
    const gw = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: "Q:\\tmp-ghc-gateway" }),
      runtime,
    }, [route]);
    const firstPromise = gw.fetch(new Request("http://127.0.0.1:31400/v1/hold-stream", { method: "POST" }));
    for (let index = 0; index < 50 && writers.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(writers.length).toBe(1);
    const first = await firstPromise;
    const overflow = await gw.fetch(new Request("http://127.0.0.1:31400/v1/hold-stream", { method: "POST" }));
    expect(overflow.status).toBe(503);
    expect(JSON.parse(await overflow.text())).toMatchObject({ kind: "queue_full" });
    writers[0]?.close();
    await first.arrayBuffer();
    const after = await gw.fetch(new Request("http://127.0.0.1:31400/v1/hold-stream", { method: "POST" }));
    expect(after.status).toBe(200);
    writers[1]?.close();
    await after.arrayBuffer();
    await gw.close();
  });
});
