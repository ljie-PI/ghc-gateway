import { Hono } from "hono";
import { VERSION } from "../version.js";
import type { RuntimeConfigSnapshot } from "../config/schema.js";
import type { AdmissionController } from "./admission.js";
import { readWireJsonObjectBody } from "./body_reader.js";
import { failureFromUnknown, GatewayFailureError, type GatewayFailure } from "./failures.js";
import { createRequestScope, type RequestScope } from "./request_scope.js";
import { abortWithTimeout, armTimeout, type TimeoutScheduler } from "./timeouts.js";
import type { WireJsonObject } from "../serialization/wire_json.js";
import type {
  AdminModule,
  AdminStaticModule,
  GatewayActivity,
  LocalControlModule,
  LoopbackOrigin,
} from "./create_gateway.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface DecodedHttpRequest {
  readonly url: URL;
  readonly headers: Headers;
  readonly body?: WireJsonObject;
}

export type ProtocolEndpoint = (
  request: Readonly<DecodedHttpRequest>,
  scope: Readonly<RequestScope>,
) => Promise<Response>;

export type FailurePresenter = (
  failure: Readonly<GatewayFailure>,
  requestId: string,
) => Response;

export interface RouteRegistration {
  readonly method: HttpMethod;
  readonly path: string;
  readonly admission: "none" | "inference";
  readonly body: "none" | "wire-json-object";
  readonly presentFailure: FailurePresenter;
  readonly endpoint: ProtocolEndpoint;
}

export interface HonoAppDependencies {
  readonly readRuntimeConfig: () => RuntimeConfigSnapshot;
  readonly admission: AdmissionController;
  readonly scheduler: TimeoutScheduler;
  readonly createRequestId: () => string;
  readonly isReady: () => boolean;
  readonly isClosed: () => boolean;
  readonly inflight: Set<AbortController>;
  readonly mountedInflight: Set<AbortController>;
  readonly listenerOrigin: LoopbackOrigin;
  readonly admin?: AdminModule;
  readonly control?: LocalControlModule;
  readonly adminStatic?: AdminStaticModule;
  readonly activity?: GatewayActivity;
  readonly streamStarted?: () => void;
  readonly streamFinished?: () => void;
}

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
} as const;

export function createHonoApp(
  routes: readonly RouteRegistration[],
  dependencies: HonoAppDependencies,
): Hono {
  const app = new Hono();

  if (dependencies.control !== undefined) {
    const handleControl = (request: Request): Promise<Response> => handleMountedRequest(
      request,
      dependencies,
      (signal) => dependencies.control!.handle(request, {
        requestId: dependencies.createRequestId(),
        signal,
        listenerOrigin: dependencies.listenerOrigin,
      }),
    );
    app.all("/__ghcg/control/v1", (context) => handleControl(context.req.raw));
    app.all("/__ghcg/control/v1/*", (context) => handleControl(context.req.raw));
  }

  const handleAdmin = (request: Request): Promise<Response> => {
    if (dependencies.admin === undefined || dependencies.activity === undefined) {
      return Promise.resolve(new Response("404 Not Found", { status: 404 }));
    }
    return handleMountedRequest(
      request,
      dependencies,
      (signal) => dependencies.admin!.handle(request, {
        requestId: dependencies.createRequestId(),
        signal,
        listenerOrigin: dependencies.listenerOrigin,
        activity: dependencies.activity!,
      }),
    );
  };
  app.all("/admin/api/v1", (context) => handleAdmin(context.req.raw));
  app.all("/admin/api/v1/*", (context) => handleAdmin(context.req.raw));

  app.get("/healthz", () => compactJson(200, { status: "ok", version: VERSION }));
  app.get("/readyz", () => {
    if (dependencies.isReady()) {
      return compactJson(200, { status: "ready" });
    }
    return compactJson(503, { status: "not_ready" });
  });

  for (const route of routes) {
    app.on(route.method, route.path, (context) => handleRoute(context.req.raw, route, dependencies));
  }

  if (dependencies.adminStatic !== undefined) {
    const handleStatic = (request: Request): Promise<Response> => handleMountedRequest(
      request,
      dependencies,
      (signal) => dependencies.adminStatic!.handle(request, signal),
    );
    app.get("/admin", (context) => handleStatic(context.req.raw));
    app.get("/admin/*", (context) => handleStatic(context.req.raw));
  }

  return app;
}

async function handleRoute(
  request: Request,
  route: RouteRegistration,
  dependencies: HonoAppDependencies,
): Promise<Response> {
  if (dependencies.isClosed()) {
    return new Response(null, { status: 503 });
  }
  const requestId = dependencies.createRequestId();
  const snapshot = structuredClone(dependencies.readRuntimeConfig());
  const controller = new AbortController();
  dependencies.inflight.add(controller);
  const onAbort = (): void => controller.abort();
  request.signal.addEventListener("abort", onAbort, { once: true });

  const scope = createRequestScope(requestId, controller.signal, snapshot);
  let release: (() => void) | undefined;
  let disarmTotal: (() => void) | undefined;
  let holdUntilBody = false;

  const cleanup = (): void => {
    disarmTotal?.();
    release?.();
    dependencies.inflight.delete(controller);
    request.signal.removeEventListener("abort", onAbort);
  };

  try {
    if (route.admission === "inference") {
      release = await dependencies.admission.acquire(snapshot, controller.signal);
      disarmTotal = armTimeout(snapshot.timeouts.totalMs, controller.signal, dependencies.scheduler, () => {
        abortWithTimeout(controller);
      });
    }

    const url = new URL(request.url);
    let decoded: DecodedHttpRequest = { url, headers: request.headers };
    if (route.body === "wire-json-object") {
      const body = await readWireJsonObjectBody(request, snapshot.limits.requestBodyBytes, controller.signal);
      decoded = { url, headers: request.headers, body };
    }

    if (controller.signal.aborted) {
      const timeoutFailure = upstreamTimeoutFromSignal(controller.signal);
      if (timeoutFailure !== undefined && !request.signal.aborted) {
        return route.presentFailure(timeoutFailure, requestId);
      }
      return new Response(null);
    }

    const response = await route.endpoint(decoded, scope);
    if (controller.signal.aborted) {
      const timeoutFailure = upstreamTimeoutFromSignal(controller.signal);
      if (timeoutFailure !== undefined && !request.signal.aborted) {
        return route.presentFailure(timeoutFailure, requestId);
      }
      return new Response(null);
    }
    holdUntilBody = true;
    const stream = dependencies.activity !== undefined && isStreamingResponse(response);
    if (stream) {
      dependencies.streamStarted?.();
    }
    return attachLifecycle(response, controller, cleanup, stream ? dependencies.streamFinished : undefined);
  } catch (error: unknown) {
    const failure = failureFromUnknown(error);
    if (failure.kind === "aborted" || request.signal.aborted) {
      const timeoutFailure = upstreamTimeoutFromSignal(controller.signal);
      if (timeoutFailure !== undefined && !request.signal.aborted) {
        return route.presentFailure(timeoutFailure, requestId);
      }
      return new Response(null);
    }
    holdUntilBody = true;
    return attachLifecycle(route.presentFailure(failure, requestId), controller, cleanup);
  } finally {
    if (!holdUntilBody) {
      cleanup();
    }
  }
}

function upstreamTimeoutFromSignal(signal: AbortSignal): GatewayFailure | undefined {
  const reason = signal.reason;
  if (reason instanceof GatewayFailureError && reason.failure.kind === "upstream_timeout") {
    return reason.failure;
  }
  return undefined;
}

function attachLifecycle(
  response: Response,
  controller: AbortController,
  cleanup: () => void,
  onFinished?: () => void,
): Response {
  const body = response.body;
  if (body === null) {
    cleanup();
    return response;
  }

  let cleaned = false;
  const once = (): void => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    onFinished?.();
    cleanup();
  };

  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(streamController): Promise<void> {
      if (controller.signal.aborted) {
        await reader.cancel().catch(() => undefined);
        once();
        streamController.close();
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) {
          once();
          streamController.close();
          return;
        }
        if (next.value !== undefined) {
          streamController.enqueue(next.value);
        }
      } catch (error: unknown) {
        once();
        streamController.error(error);
      }
    },
    async cancel(): Promise<void> {
      if (!controller.signal.aborted) {
        controller.abort();
      }
      await reader.cancel().catch(() => undefined);
      once();
    },
  });

  controller.signal.addEventListener("abort", () => {
    void reader.cancel().catch(() => undefined);
    once();
  }, { once: true });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function handleMountedRequest(
  request: Request,
  dependencies: HonoAppDependencies,
  handle: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  if (dependencies.isClosed()) {
    return new Response(null, { status: 503 });
  }

  const controller = new AbortController();
  dependencies.mountedInflight.add(controller);
  const onAbort = (): void => controller.abort();
  if (request.signal.aborted) {
    controller.abort();
  } else {
    request.signal.addEventListener("abort", onAbort, { once: true });
  }

  let holdUntilBody = false;
  const cleanup = (): void => {
    dependencies.mountedInflight.delete(controller);
    request.signal.removeEventListener("abort", onAbort);
  };

  try {
    if (controller.signal.aborted) {
      return new Response(null);
    }
    const response = await handle(controller.signal);
    if (controller.signal.aborted) {
      return new Response(null);
    }
    holdUntilBody = response.body !== null;
    return holdUntilBody ? attachLifecycle(response, controller, cleanup) : response;
  } catch (error: unknown) {
    if (controller.signal.aborted) {
      return new Response(null);
    }
    throw error;
  } finally {
    if (!holdUntilBody) {
      cleanup();
    }
  }
}

function isStreamingResponse(response: Response): boolean {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "text/event-stream" || mediaType === "application/x-ndjson";
}

function compactJson(status: number, body: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
