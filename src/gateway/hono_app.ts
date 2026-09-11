import { Hono } from "hono";
import { VERSION } from "../version.js";
import type { RuntimeConfigSnapshot } from "../config/schema.js";
import type { AdmissionController } from "./admission.js";
import { readWireJsonObjectBody } from "./body_reader.js";
import { failureFromUnknown, GatewayFailureError, type GatewayFailure } from "./failures.js";
import { createRequestScope, type RequestScope } from "./request_scope.js";
import { createRequestAttempt, type RequestAttempt } from "./request_attempt.js";
import {
  boundedCleanup,
  getStreamExecutionHandle,
  type StreamExecutionDelivery,
  type StreamExecutionHandle,
} from "./stream_execution.js";
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
  request: Request,
) => Response;

export interface RouteRegistration {
  readonly method: HttpMethod;
  readonly path: string;
  readonly admission: "none" | "inference";
  readonly body: "none" | "wire-json-object";
  readonly presentFailure: FailurePresenter;
  readonly createAttempt?: (
    requestId: string,
    config: Readonly<RuntimeConfigSnapshot>,
  ) => RequestAttempt;
  readonly endpoint: ProtocolEndpoint;
}

export interface InflightRequest {
  abortForShutdown(): Promise<void>;
}

export interface HonoAppDependencies {
  readonly readRuntimeConfig: () => RuntimeConfigSnapshot;
  readonly admission: AdmissionController;
  readonly scheduler: TimeoutScheduler;
  readonly createRequestId: () => string;
  readonly isReady: () => boolean;
  readonly isClosed: () => boolean;
  readonly inflight: Set<InflightRequest>;
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
const RESPONSE_BODY_CLEANUP_MS = 2_500;

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
  const attempt = route.createAttempt?.(requestId, snapshot) ?? createRequestAttempt({
    requestId,
    config: snapshot,
    protocol: "openai_chat",
    abortedErrorCount: 0,
  });
  const workController = new AbortController();
  const deliveryController = new AbortController();
  let resolveSettled: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  let streamExecution: StreamExecutionHandle | undefined;
  const abortDelivery = (failure: GatewayFailure): void => {
    const error = new GatewayFailureError(failure);
    attempt.failure(error);
    if (!workController.signal.aborted) {
      workController.abort(error);
    }
    if (!deliveryController.signal.aborted) {
      deliveryController.abort(error);
    }
  };
  const cancelResponseDelivery = (failure: GatewayFailure): void => {
    const error = new GatewayFailureError(failure);
    attempt.failure(error);
    if (!deliveryController.signal.aborted) {
      deliveryController.abort(error);
    }
    if (!workController.signal.aborted) {
      workController.abort(error);
    }
  };
  const inflight: InflightRequest = {
    abortForShutdown: async () => {
      const streamCompletion = streamExecution?.abort("shutdown");
      abortDelivery({
        kind: "aborted",
        source: "gateway",
        phase: "internal",
      });
      await streamCompletion;
      await settled;
    },
  };
  dependencies.inflight.add(inflight);
  const onAbort = (): void => abortDelivery({
    kind: "aborted",
    source: "request",
    phase: "body",
  });
  if (request.signal.aborted) {
    onAbort();
  } else {
    request.signal.addEventListener("abort", onAbort, { once: true });
  }

  const scope = createRequestScope(
    requestId,
    workController.signal,
    deliveryController.signal,
    snapshot,
    attempt,
  );
  let release: (() => void) | undefined;
  let disarmTotal: (() => void) | undefined;
  let holdUntilBody = false;

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    disarmTotal?.();
    release?.();
    dependencies.inflight.delete(inflight);
    request.signal.removeEventListener("abort", onAbort);
    resolveSettled();
  };

  try {
    if (route.admission === "inference") {
      release = await dependencies.admission.acquire(snapshot, workController.signal);
      disarmTotal = armTimeout(snapshot.timeouts.totalMs, workController.signal, dependencies.scheduler, () => {
        abortWithTimeout(workController);
        attempt.failure(workController.signal.reason);
      });
    }

    const url = new URL(request.url);
    let decoded: DecodedHttpRequest = { url, headers: request.headers };
    if (route.body === "wire-json-object") {
      const body = await readWireJsonObjectBody(request, snapshot.limits.requestBodyBytes, workController.signal);
      decoded = { url, headers: request.headers, body };
    }

    if (workController.signal.aborted) {
      const timeoutFailure = upstreamTimeoutFromSignal(workController.signal);
      if (timeoutFailure !== undefined && !request.signal.aborted) {
        attempt.failure(new GatewayFailureError(timeoutFailure));
        const response = route.presentFailure(timeoutFailure, requestId, request);
        holdUntilBody = response.body !== null;
        attempt.markPrepared();
        attempt.markHandedOff();
        return holdUntilBody
          ? attachLifecycle(response, deliveryController.signal, onAbort, attempt, cleanup)
          : response;
      }
      return new Response(null);
    }

    const response = await route.endpoint(decoded, scope);
    streamExecution = getStreamExecutionHandle(response);
    if (workController.signal.aborted) {
      await streamExecution?.completion;
      const timeoutFailure = upstreamTimeoutFromSignal(workController.signal);
      if (timeoutFailure !== undefined && !request.signal.aborted) {
        attempt.failure(new GatewayFailureError(timeoutFailure));
        const timeoutResponse = route.presentFailure(timeoutFailure, requestId, request);
        holdUntilBody = timeoutResponse.body !== null;
        attempt.markPrepared();
        attempt.markHandedOff();
        return holdUntilBody
          ? attachLifecycle(timeoutResponse, deliveryController.signal, onAbort, attempt, cleanup)
          : timeoutResponse;
      }
      return new Response(null);
    }
    holdUntilBody = true;
    attempt.markPrepared();
    attempt.markHandedOff();
    const stream = dependencies.activity !== undefined && isStreamingResponse(response);
    if (stream) {
      dependencies.streamStarted?.();
    }
    return attachLifecycle(
      response,
      deliveryController.signal,
      () => cancelResponseDelivery({ kind: "aborted", source: "request", phase: "stream" }),
      attempt,
      cleanup,
      stream ? dependencies.streamFinished : undefined,
      streamExecution,
    );
  } catch (error: unknown) {
    const failure = failureFromUnknown(error);
    const timeoutFailure = upstreamTimeoutFromSignal(workController.signal);
    if (timeoutFailure !== undefined && !request.signal.aborted) {
      attempt.failure(new GatewayFailureError(timeoutFailure));
      const response = route.presentFailure(timeoutFailure, requestId, request);
      holdUntilBody = response.body !== null;
      attempt.markPrepared();
      attempt.markHandedOff();
      return holdUntilBody
        ? attachLifecycle(response, deliveryController.signal, onAbort, attempt, cleanup)
        : response;
    }
    attempt.failure(new GatewayFailureError(failure));
    if (request.signal.aborted || (failure.kind === "aborted" && workController.signal.aborted)) {
      return new Response(null);
    }
    const response = route.presentFailure(failure, requestId, request);
    holdUntilBody = response.body !== null;
    attempt.markPrepared();
    attempt.markHandedOff();
    return holdUntilBody
      ? attachLifecycle(response, deliveryController.signal, onAbort, attempt, cleanup)
      : response;
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
  deliverySignal: AbortSignal,
  abortDelivery: () => void,
  attempt: RequestAttempt,
  cleanup: () => void,
  onFinished?: () => void,
  streamExecution?: StreamExecutionHandle,
): Response {
  const body = response.body;
  if (body === null) {
    cleanup();
    return response;
  }

  let cleaned = false;
  let onDeliveryAbort: () => void = () => undefined;
  const once = (): void => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    deliverySignal.removeEventListener("abort", onDeliveryAbort);
    onFinished?.();
    cleanup();
  };

  let delivery: StreamExecutionDelivery | undefined;
  if (streamExecution !== undefined) {
    delivery = streamExecution.claimDeliveryAdapter(once);
  }

  const reader = body.getReader();
  let cancellation: Promise<void> | undefined;
  const cancelBody = async (): Promise<void> => {
    cancellation ??= boundedCleanup(reader.cancel(), RESPONSE_BODY_CLEANUP_MS);
    await cancellation;
  };
  const settleDelivery = (): void => {
    delivery?.settle();
  };
  const awaitOwner = async (): Promise<void> => {
    await streamExecution?.completion;
    if (streamExecution === undefined) {
      once();
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(streamController): Promise<void> {
      if (deliverySignal.aborted) {
        settleDelivery();
        await cancelBody();
        await awaitOwner();
        streamController.close();
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) {
          settleDelivery();
          await cancellation;
          await awaitOwner();
          streamController.close();
          return;
        }
        if (next.value !== undefined) {
          attempt.markCommitted();
          streamController.enqueue(next.value);
          delivery?.markDelivered();
        }
      } catch (error: unknown) {
        settleDelivery();
        await awaitOwner();
        streamController.error(error);
      }
    },
    async cancel(): Promise<void> {
      settleDelivery();
      abortDelivery();
      await cancelBody();
      await awaitOwner();
    },
  });

  onDeliveryAbort = () => {
    settleDelivery();
    void cancelBody().then(awaitOwner, awaitOwner);
  };
  const alreadyAborted = deliverySignal.aborted;
  deliverySignal.addEventListener("abort", onDeliveryAbort, { once: true });
  if (alreadyAborted || deliverySignal.aborted) {
    onDeliveryAbort();
  }

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
    return holdUntilBody
      ? attachLifecycle(
        response,
        controller.signal,
        () => {
          if (!controller.signal.aborted) {
            controller.abort();
          }
        },
        createRequestAttempt({
          requestId: "req_mounted",
          protocol: "openai_chat",
          abortedErrorCount: 0,
        }),
        cleanup,
      )
      : response;
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
  const wire = JSON.stringify(body);
  const headers = new Headers(JSON_HEADERS);
  headers.set("Content-Length", String(new TextEncoder().encode(wire).byteLength));
  return new Response(wire, { status, headers });
}
