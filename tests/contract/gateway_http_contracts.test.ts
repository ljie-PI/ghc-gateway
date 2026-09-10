import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRuntimeConfigSnapshot, parseRuntimeConfigSnapshot } from "../../src/config/schema.js";
import {
  assertLoopbackBindHost,
  LOOPBACK_HOST,
  parseStartupConfig,
  StartupConfigError,
} from "../../src/config/startup_config.js";
import { AdmissionController, defaultDelay } from "../../src/gateway/admission.js";
import { createGateway, type Gateway } from "../../src/gateway/create_gateway.js";
import type { FailurePresenter, RouteRegistration } from "../../src/gateway/hono_app.js";
import { VERSION } from "../../src/version.js";

const PROBE_ROOT = path.resolve("tests/fixtures/gateway-http-host/probe");

const fakePresenter: FailurePresenter = (failure, requestId) => {
  const status = failure.kind === "queue_full" || failure.kind === "queue_timeout"
    ? 503
    : failure.kind === "body_too_large"
      ? 413
      : failure.kind === "unsupported_media_type"
        ? 415
        : failure.kind === "upstream_timeout"
          ? 504
          : 400;
  return new Response(JSON.stringify({ kind: failure.kind, requestId }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "x-request-id": requestId,
    },
  });
};

function echoRoute(overrides: Partial<RouteRegistration> = {}): RouteRegistration {
  return {
    method: "POST",
    path: "/v1/echo",
    admission: "inference",
    body: "wire-json-object",
    presentFailure: fakePresenter,
    endpoint: async (request, scope) => new Response(JSON.stringify({
      hasBody: request.body !== undefined,
      requestId: scope.requestId,
      activeMax: scope.config.admission.activeMax,
      requestBodyBytes: scope.config.limits.requestBodyBytes,
      accumulatorBytes: scope.config.limits.accumulatorBytes,
      nonstreamBodyBytes: scope.config.limits.nonstreamBodyBytes,
    }), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "x-request-id": scope.requestId,
      },
    }),
    ...overrides,
  };
}

async function gatewayWith(routes: readonly RouteRegistration[], options: {
  runtime?: ReturnType<typeof defaultRuntimeConfigSnapshot>;
  isReady?: () => boolean;
  createRequestId?: () => string;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
} = {}): Promise<Gateway> {
  const dependencies: {
    isReady?: () => boolean;
    createRequestId?: () => string;
    delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  } = {};
  if (options.isReady !== undefined) {
    dependencies.isReady = options.isReady;
  }
  if (options.createRequestId !== undefined) {
    dependencies.createRequestId = options.createRequestId;
  }
  if (options.delay !== undefined) {
    dependencies.delay = options.delay;
  }
  return createGateway({
    startup: parseStartupConfig([], {}, { homedir: "Q:\\tmp-ghc-gateway" }),
    runtime: options.runtime ?? defaultRuntimeConfigSnapshot(),
  }, routes, dependencies);
}

function jsonRequest(pathName: string, body: string, headers: HeadersInit = {}): Request {
  return new Request(`http://127.0.0.1:31400${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

interface StreamingRequestInit extends RequestInit {
  readonly duplex: "half";
}

function streamingJsonRequest(
  pathName: string,
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Request {
  const init: StreamingRequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    ...(signal === undefined ? {} : { signal }),
    duplex: "half",
  };
  return new Request(`http://127.0.0.1:31400${pathName}`, init);
}

function stalledJsonBody(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(new TextEncoder().encode("{"));
    },
    pull: async (): Promise<void> => {
      await new Promise<void>(() => undefined);
    },
    cancel(): void {
      onCancel();
    },
  });
}

describe("startup config", () => {
  it("uses CLI then env then default precedence and ranges", () => {
    const parsed = parseStartupConfig(
      ["--port", "4000", "--log-level", "debug", "--data-dir", "data"],
      { GHC_GATEWAY_PORT: "31400", GHC_GATEWAY_LOG_LEVEL: "warn", GHC_GATEWAY_DATA_DIR: "env-data" },
      { homedir: "Q:\\home" },
    );
    expect(parsed.host).toBe(LOOPBACK_HOST);
    expect(parsed.port).toBe(4000);
    expect(parsed.logLevel).toBe("debug");
    expect(parsed.dataDir.endsWith("data")).toBe(true);

    const fromEnv = parseStartupConfig([], {
      GHC_GATEWAY_PORT: "255",
      GHC_GATEWAY_LOG_LEVEL: "error",
    }, { homedir: "Q:\\home" });
    expect(fromEnv.port).toBe(255);
    expect(fromEnv.logLevel).toBe("error");
    expect(fromEnv.dataDir.replaceAll("\\", "/")).toContain(".ghc-gateway");

    const defaults = parseStartupConfig([], {}, { homedir: "Q:\\home" });
    expect(defaults.port).toBe(31400);
    expect(defaults.logLevel).toBe("info");
  });

  it("rejects non-loopback bind before listen", () => {
    expect(() => assertLoopbackBindHost("0.0.0.0")).toThrow(StartupConfigError);
    expect(() => parseStartupConfig(["--port", "0"], {}, { homedir: "Q:\\home" })).toThrow(StartupConfigError);
    expect(() => parseStartupConfig(["--port", "65536"], {}, { homedir: "Q:\\home" })).toThrow(StartupConfigError);
  });

  it("rejects TypeBox coercion of runtime config strings", () => {
    const candidate = defaultRuntimeConfigSnapshot() as unknown as Record<string, unknown>;
    expect(() => parseRuntimeConfigSnapshot({
      ...candidate,
      admission: { activeMax: "4", queueMax: 16 },
    })).toThrow(/invalid runtime config/u);
  });
});

describe("probes and route surface", () => {
  it("returns exact probe bodies and headers", async () => {
    const gw = await gatewayWith([]);
    for (const [route, file] of [
      ["/healthz", "healthz.expected.json"],
      ["/readyz", "readyz.expected.json"],
    ] as const) {
      const response = await gw.fetch(new Request(`http://127.0.0.1:31400${route}`));
      const expected = await readFile(path.join(PROBE_ROOT, file), "utf8");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-request-id")).toBeNull();
      expect(await response.text()).toBe(expected);
    }
    expect(VERSION).toBe("0.1.0");
    await gw.close();
    await gw.close();
  });

  it("marks unreadiness without exposing the failed dependency", async () => {
    const gw = await gatewayWith([], { isReady: () => false });
    const response = await gw.fetch(new Request("http://127.0.0.1:31400/readyz"));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("{\"status\":\"not_ready\"}");
    const health = await gw.fetch(new Request("http://127.0.0.1:31400/healthz"));
    expect(health.status).toBe(200);
    await gw.close();
  });

  it("does not register inference aliases or stub routes", async () => {
    const gw = await gatewayWith([]);
    for (const url of ["/v1/chat/completions", "/models", "/responses", "/v1/chat/completions/"]) {
      const response = await gw.fetch(new Request(`http://127.0.0.1:31400${url}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }));
      expect(response.status, url).toBe(404);
    }
    expect((await gw.fetch(new Request("http://127.0.0.1:31400/healthz/"))).status).toBe(404);
    expect((await gw.fetch(new Request("http://127.0.0.1:31400/healthz", { method: "POST" }))).status).toBe(404);
    await gw.close();
  });
});

describe("body reading and fake presenter", () => {
  it("accepts JSON objects and invokes the fake presenter on host failures", async () => {
    const gw = await gatewayWith([echoRoute()]);
    const ok = await gw.fetch(jsonRequest("/v1/echo", "{\"a\":1}"));
    expect(ok.status).toBe(200);
    const okBody = JSON.parse(await ok.text()) as { hasBody: boolean };
    expect(okBody.hasBody).toBe(true);

    const malformed = await gw.fetch(jsonRequest("/v1/echo", "{\"a\":1,}"));
    expect(malformed.status).toBe(400);
    expect(JSON.parse(await malformed.text())).toMatchObject({ kind: "invalid_request" });

    const arrayRoot = await gw.fetch(jsonRequest("/v1/echo", "[1]"));
    expect(JSON.parse(await arrayRoot.text())).toMatchObject({ kind: "invalid_request" });

    const missingType = await gw.fetch(new Request("http://127.0.0.1:31400/v1/echo", {
      method: "POST",
      body: "{}",
    }));
    expect(missingType.status).toBe(415);

    const gzip = await gw.fetch(jsonRequest("/v1/echo", "{}", { "content-encoding": "gzip" }));
    expect(gzip.status).toBe(415);

    const headers = new Headers();
    headers.append("content-encoding", "identity");
    headers.append("content-encoding", "gzip");
    const merged = await gw.fetch(new Request("http://127.0.0.1:31400/v1/echo", {
      method: "POST",
      headers,
      body: "{}",
    }));
    expect(merged.status).toBe(415);
    await gw.close();
  });

  it("enforces the captured request body limit without truncation", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.limits.requestBodyBytes = 1_048_576;
    const gw = await gatewayWith([echoRoute()], { runtime });
    const tooLarge = await gw.fetch(jsonRequest("/v1/echo", `{"a":"${"x".repeat(1_048_576)}"}`));
    expect(tooLarge.status).toBe(413);
    expect(JSON.parse(await tooLarge.text())).toMatchObject({ kind: "body_too_large" });
    await gw.close();
  });

  it("ignores inbound request IDs", async () => {
    let counter = 0;
    const gw = await gatewayWith([echoRoute()], {
      createRequestId: () => `req_generated_${counter += 1}`,
    });
    const response = await gw.fetch(jsonRequest("/v1/echo", "{}", {
      "x-request-id": "req_client",
      "request-id": "req_client",
    }));
    expect(response.headers.get("x-request-id")).toBe("req_generated_1");
    await gw.close();
  });

  it("times out stalled uploads and releases the inference slot", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.admission.activeMax = 1;
    runtime.admission.queueMax = 0;
    runtime.timeouts.totalMs = 1;
    let canceled = false;
    const gw = await gatewayWith([echoRoute()], { runtime });
    try {
      const timedOut = await gw.fetch(streamingJsonRequest("/v1/echo", stalledJsonBody(() => {
        canceled = true;
      })));
      expect(timedOut.status).toBe(504);
      expect(JSON.parse(await timedOut.text())).toMatchObject({ kind: "upstream_timeout" });
      expect(canceled).toBe(true);

      const after = await gw.fetch(jsonRequest("/v1/echo", "{}"));
      expect(after.status).toBe(200);
    } finally {
      await gw.close();
    }
  });

  it("cancels body reads on client abort without writing a response", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.admission.activeMax = 1;
    runtime.admission.queueMax = 0;
    let canceled = false;
    const controller = new AbortController();
    const gw = await gatewayWith([echoRoute()], { runtime });
    try {
      const pending = gw.fetch(streamingJsonRequest("/v1/echo", stalledJsonBody(() => {
        canceled = true;
      }), controller.signal));
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      const response = await pending;
      expect(response.body).toBeNull();
      expect(canceled).toBe(true);

      const after = await gw.fetch(jsonRequest("/v1/echo", "{}"));
      expect(after.status).toBe(200);
    } finally {
      await gw.close();
    }
  });

  it("cancels in-flight body reads when the gateway closes", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.admission.activeMax = 1;
    runtime.admission.queueMax = 0;
    let canceled = false;
    const gw = await gatewayWith([echoRoute()], { runtime });
    try {
      const pending = gw.fetch(streamingJsonRequest("/v1/echo", stalledJsonBody(() => {
        canceled = true;
      })));
      await new Promise((resolve) => setTimeout(resolve, 20));
      await gw.close();
      const response = await pending;
      expect(response.body).toBeNull();
      expect(canceled).toBe(true);
    } finally {
      await gw.close();
    }
  });
});

describe("admission", () => {
  it("enforces four active, sixteen queued, and queue_full", async () => {
    const controller = new AdmissionController(defaultDelay, Date.now);
    const snapshot = defaultRuntimeConfigSnapshot();
    const inflight: Array<() => void> = [];
    for (let index = 0; index < 4; index += 1) {
      inflight.push(await controller.acquire(snapshot, new AbortController().signal));
    }
    const queued = Array.from({ length: 16 }, () => controller.acquire(snapshot, new AbortController().signal));
    await expect(controller.acquire(snapshot, new AbortController().signal)).rejects.toMatchObject({
      failure: { kind: "queue_full" },
    });
    expect(controller.activeCount).toBe(4);
    expect(controller.queuedCount).toBe(16);
    for (const release of inflight) {
      release();
    }
    controller.close();
    const settled = await Promise.allSettled(queued);
    expect(settled.length).toBe(16);
  });

  it("times out queued waiters using the captured snapshot", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.admission.activeMax = 1;
    runtime.admission.queueMax = 1;
    runtime.timeouts.queueMs = 1000;
    let release = (): void => undefined;
    const route = echoRoute({
      endpoint: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return new Response("{}");
      },
    });
    const gw = await gatewayWith([route], { runtime });
    const blocked = gw.fetch(jsonRequest("/v1/echo", "{}"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const queued = gw.fetch(jsonRequest("/v1/echo", "{}"));
    const timedOut = await queued;
    expect(timedOut.status).toBe(503);
    expect(JSON.parse(await timedOut.text())).toMatchObject({ kind: "queue_timeout" });
    release();
    expect((await blocked).status).toBe(200);
    await gw.close();
  });

  it("removes aborted waiters without writing a response", async () => {
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.admission.activeMax = 1;
    runtime.admission.queueMax = 4;
    let release = (): void => undefined;
    const route = echoRoute({
      endpoint: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return new Response("{}");
      },
    });
    const gw = await gatewayWith([route], { runtime });
    const blocked = gw.fetch(jsonRequest("/v1/echo", "{}"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const abort = new AbortController();
    const queued = gw.fetch(new Request("http://127.0.0.1:31400/v1/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: abort.signal,
    }));
    abort.abort();
    const aborted = await queued;
    expect(aborted.body).toBeNull();
    release();
    expect((await blocked).status).toBe(200);
    await gw.close();
  });
});
