import { describe, expect, it } from "vitest";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createGateway } from "../../src/gateway/create_gateway.js";
import { createStreamResponseWriter } from "../../src/gateway/stream_response.js";
import {
  createStreamExecutionResponse,
  getStreamExecutionHandle,
  type StreamExecutionEmission,
} from "../../src/gateway/stream_execution.js";
import type { UpstreamByteStream } from "../../src/copilot/upstream_types.js";
import { armTimeout } from "../../src/gateway/timeouts.js";
import type { RouteRegistration } from "../../src/gateway/hono_app.js";

describe("stream writer", () => {
  it("is pull-based, commits on first body byte, and writes nothing after abort", async () => {
    const writer = createStreamResponseWriter({});
    expect(writer.committed).toBe(false);

    const first = new Uint8Array([1, 2, 3]);
    let enqueueSettled = false;
    const accepted = writer.enqueue(first).then((value) => {
      enqueueSettled = true;
      return value;
    });
    await Promise.resolve();
    expect(enqueueSettled).toBe(false);
    const reader = writer.response.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await reader?.read();
    expect(await accepted).toBe(true);
    expect(writer.committed).toBe(true);
    expect(chunk?.value).toEqual(first);

    writer.abort();
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
      endpoint: async (_request, _scope) => {
        const writer = createStreamResponseWriter({          headers: { "Content-Type": "text/event-stream" },
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

    let release!: () => void;
    const elapsed = new Promise<void>((resolve) => { release = resolve; });
    let scheduledMs = 0;
    const controller = new AbortController();
    let timedOut = false;
    const disarm = armTimeout(1_000, controller.signal, {
      nowMs: () => 5_000,
      delay: async (ms) => {
        scheduledMs = ms;
        await elapsed;
      },
    }, () => {
      timedOut = true;
      controller.abort();
    });
    expect(scheduledMs).toBe(1_000);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(timedOut).toBe(true);
    disarm();
  });


  it("disarms timers and aborts in-flight work on close", async () => {
    let markEndpointStarted!: () => void;
    const endpointStarted = new Promise<void>((resolve) => { markEndpointStarted = resolve; });
    const route: RouteRegistration = {
      method: "POST",
      path: "/v1/hold",
      admission: "inference",
      body: "none",
      presentFailure: (failure) => new Response(JSON.stringify({ kind: failure.kind }), { status: 503 }),
      endpoint: async (_request, scope) => {
        markEndpointStarted();
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
    await endpointStarted;
    await gw.close();
    const closed = await pending;
    expect(closed.body).toBeNull();
    const after = await gw.fetch(new Request("http://127.0.0.1:31400/healthz"));
    expect(after.status).toBe(503);
  });

  it("holds the inference slot until the stream body ends", async () => {
    const writers: ReturnType<typeof createStreamResponseWriter>[] = [];
    let markWriterStarted!: () => void;
    const writerStarted = new Promise<void>((resolve) => { markWriterStarted = resolve; });
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
      endpoint: async (_request, _scope) => {
        const writer = createStreamResponseWriter({});
        writers.push(writer);
        markWriterStarted();
        return writer.response;
      },
    };
    const gw = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: "Q:\\tmp-ghc-gateway" }),
      runtime,
    }, [route]);
    const firstPromise = gw.fetch(new Request("http://127.0.0.1:31400/v1/hold-stream", { method: "POST" }));
    await writerStarted;
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

describe("Stream Execution cleanup evidence", () => {
  it("tracks semantic terminal and resource cleanup exactly once", async () => {
    const counts = { cancel: 0, returned: 0, terminal: 0 };
    const upstream: UpstreamByteStream = {
      status: 200,
      headers: new Headers(),
      bytes: { async *[Symbol.asyncIterator]() { yield new Uint8Array(); } },
      cancel: async () => { counts.cancel += 1; },
    };
    const emissions: AsyncIterable<StreamExecutionEmission<string>> = {
      [Symbol.asyncIterator](): AsyncIterator<StreamExecutionEmission<string>> {
        let index = 0;
        return {
          next: async () => index++ === 0
            ? { done: false, value: { kind: "wire", bytes: new TextEncoder().encode("ok") } }
            : {
              done: false,
              value: {
                kind: "terminal",
                outcome: { kind: "success", value: "success" },
                writerMode: "close",
              },
            },
          return: async () => {
            counts.returned += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };

    const response = await createStreamExecutionResponse({
      upstream,
      emissions,
      signal: new AbortController().signal,
      deliverySignal: new AbortController().signal,
      headers: { "Content-Type": "text/event-stream" },
      onTerminal: () => { counts.terminal += 1; },
      normalizeFailure: (error) => error,
    });
    const handle = getStreamExecutionHandle(response);
    expect(handle).toBeDefined();
    expect(await response.text()).toBe("ok");
    await handle?.completion;

    expect(handle?.state).toBe("completed");
    expect(handle?.cause).toBe("semantic_success");
    expect(counts).toEqual({ cancel: 1, returned: 1, terminal: 1 });
  });

  it("aborts a committed stream once and continues cleanup after cancellation rejects", async () => {
    const counts = { cancel: 0, returned: 0, terminal: 0 };
    const upstream: UpstreamByteStream = {
      status: 200,
      headers: new Headers(),
      bytes: { async *[Symbol.asyncIterator]() { yield new Uint8Array(); } },
      cancel: async () => {
        counts.cancel += 1;
        throw new Error("cancel failed");
      },
    };
    const emissions: AsyncIterable<StreamExecutionEmission<string>> = {
      [Symbol.asyncIterator](): AsyncIterator<StreamExecutionEmission<string>> {
        let emitted = false;
        return {
          next: async () => {
            if (!emitted) {
              emitted = true;
              return { done: false, value: { kind: "wire", bytes: new TextEncoder().encode("prefix") } };
            }
            throw new Error("parse failed");
          },
          return: async () => {
            counts.returned += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const response = await createStreamExecutionResponse({
      upstream,
      emissions,
      signal: new AbortController().signal,
      deliverySignal: new AbortController().signal,
      onTerminal: () => { counts.terminal += 1; },
      normalizeFailure: (error) => error,
      presentPostCommitFailure: (error) => new Error("stream error", { cause: error }),
    });
    const handle = getStreamExecutionHandle(response);
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("prefix");
    await expect(reader?.read()).rejects.toThrow("stream error");
    await handle?.completion;

    expect(handle?.cause).toBe("postcommit_failure");
    expect(counts).toEqual({ cancel: 1, returned: 1, terminal: 1 });
  });

  it("waits for the claimed Stream Execution barrier before application close hooks", async () => {
    let releaseCancel: (() => void) | undefined;
    const cancelBarrier = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    let closeSawCleanup = false;
    let cleanupComplete = false;
    const route: RouteRegistration = {
      method: "POST",
      path: "/v1/owned-cleanup-barrier",
      admission: "inference",
      body: "none",
      presentFailure: () => new Response("{}"),
      endpoint: async (_request, scope) => {
        const upstream: UpstreamByteStream = {
          status: 200,
          headers: new Headers(),
          bytes: { async *[Symbol.asyncIterator]() { yield new Uint8Array(); } },
          cancel: async () => {
            await cancelBarrier;
            cleanupComplete = true;
          },
        };
        let releaseNext: ((value: IteratorResult<StreamExecutionEmission<string>>) => void) | undefined;
        const blockedNext = new Promise<IteratorResult<StreamExecutionEmission<string>>>((resolve) => {
          releaseNext = resolve;
        });
        return await createStreamExecutionResponse({
          upstream,
          emissions: {
            [Symbol.asyncIterator](): AsyncIterator<StreamExecutionEmission<string>> {
              let emitted = false;
              return {
                next: async () => {
                  if (!emitted) {
                    emitted = true;
                    return { done: false, value: { kind: "wire", bytes: new TextEncoder().encode("open") } };
                  }
                  return await blockedNext;
                },
                return: async () => {
                  releaseNext?.({ done: true, value: undefined });
                  return { done: true, value: undefined };
                },
              };
            },
          },
          signal: scope.signal,
          deliverySignal: scope.deliverySignal,
          onTerminal: () => undefined,
          normalizeFailure: (error) => error,
        });
      },
    };
    const gw = await createGateway({
      startup: parseStartupConfig([], {}, { homedir: "Q:\\tmp-ghc-gateway" }),
      runtime: defaultRuntimeConfigSnapshot(),
    }, [route], {
      onClose: () => {
        closeSawCleanup = cleanupComplete;
      },
    });
    const response = await gw.fetch(new Request("http://127.0.0.1:31400/v1/owned-cleanup-barrier", { method: "POST" }));
    expect(response.body).not.toBeNull();
    let closeSettled = false;
    const closing = gw.close().then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releaseCancel?.();
    await closing;
    expect(closeSawCleanup).toBe(true);
  });
});
