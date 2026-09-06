import { serve } from "@hono/node-server";
import type { RuntimeConfigSnapshot } from "../config/schema.js";
import {
  assertLoopbackBindHost,
  LOOPBACK_HOST,
  type StartupConfig,
} from "../config/startup_config.js";
import { AdmissionController, defaultDelay, type DelayFn } from "./admission.js";
import { createHonoApp, type InflightRequest, type RouteRegistration } from "./hono_app.js";
import type { TimeoutScheduler } from "./timeouts.js";

export interface GatewayListener {
  readonly listening: boolean;
  once(event: "listening", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  off(event: "listening", listener: () => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  close(callback: (error?: Error) => void): void;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

export type GatewayListen = (options: Readonly<{
  fetch: (request: Request) => Response | Promise<Response>;
  hostname: typeof LOOPBACK_HOST;
  port: number;
}>) => GatewayListener;

export interface Gateway {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

export interface HostedGateway extends Gateway {
  listen(): Promise<{ host: typeof LOOPBACK_HOST; port: number }>;
}

export interface GatewayConfig {
  readonly startup: StartupConfig;
  readonly runtime: RuntimeConfigSnapshot;
}

export type LoopbackOrigin = `http://127.0.0.1:${number}`;

export interface GatewayActivity {
  snapshot(): Readonly<{
    activeRequests: number;
    activeStreams: number;
    queuedRequests: number;
  }>;
}

export interface AdminRequestContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly listenerOrigin: LoopbackOrigin;
  readonly activity: GatewayActivity;
}

export type AdminBootstrapResult =
  | { readonly kind: "issued"; readonly token: string; readonly expiresAt: string }
  | { readonly kind: "capacity" }
  | { readonly kind: "closed" };

export interface AdminModule {
  handle(request: Request, context: Readonly<AdminRequestContext>): Promise<Response>;
  mintBootstrap(): AdminBootstrapResult;
  close(): void;
}

export interface AdminStaticModule {
  handle(request: Request, signal: AbortSignal): Promise<Response>;
}

export interface LocalControlModule {
  handle(
    request: Request,
    context: Readonly<{
      requestId: string;
      signal: AbortSignal;
      listenerOrigin: LoopbackOrigin;
    }>,
  ): Promise<Response>;
  close(): void;
}

export interface GatewayDependencies {
  readonly nowMs?: () => number;
  readonly delay?: DelayFn;
  readonly createRequestId?: () => string;
  readonly isReady?: () => boolean;
  readonly onClose?: () => Promise<void> | void;
  readonly onForceClose?: () => Promise<void> | void;
  readonly onShutdownTimeout?: () => void;
  readonly admin?: AdminModule;
  readonly control?: LocalControlModule;
  readonly adminStatic?: AdminStaticModule;
  readonly readRuntimeConfig?: () => RuntimeConfigSnapshot;
  readonly listen?: GatewayListen;
}

export const GRACEFUL_SHUTDOWN_MS = 10_000;

export type { RouteRegistration };

export async function createGateway(
  config: Readonly<GatewayConfig>,
  routes: readonly RouteRegistration[],
  dependencies: Readonly<GatewayDependencies> = {},
): Promise<HostedGateway> {
  assertLoopbackBindHost(config.startup.host);

  const nowMs = dependencies.nowMs ?? Date.now;
  const delay = dependencies.delay ?? defaultDelay;
  const scheduler: TimeoutScheduler = { nowMs, delay };
  const admission = new AdmissionController(delay, nowMs);
  const inflight = new Set<InflightRequest>();
  const mountedInflight = new Set<AbortController>();
  let activeStreams = 0;
  let closed = false;
  const activity: GatewayActivity | undefined = dependencies.admin === undefined
    ? undefined
    : {
      snapshot: () => ({
        activeRequests: admission.activeCount,
        activeStreams,
        queuedRequests: admission.queuedCount,
      }),
    };
  const appDependencies = {
    readRuntimeConfig: dependencies.readRuntimeConfig ?? (() => config.runtime),
    admission,
    scheduler,
    createRequestId: dependencies.createRequestId ?? defaultRequestId,
    isReady: dependencies.isReady ?? (() => true),
    isClosed: () => closed,
    inflight,
    mountedInflight,
    listenerOrigin: `http://${LOOPBACK_HOST}:${config.startup.port}` as LoopbackOrigin,
    ...(dependencies.admin === undefined ? {} : { admin: dependencies.admin }),
    ...(dependencies.control === undefined ? {} : { control: dependencies.control }),
    ...(dependencies.adminStatic === undefined ? {} : { adminStatic: dependencies.adminStatic }),
    ...(activity === undefined
      ? {}
      : {
        activity,
        streamStarted: () => {
          activeStreams += 1;
        },
        streamFinished: () => {
          activeStreams = Math.max(0, activeStreams - 1);
        },
      }),
  };
  const app = createHonoApp(routes, appDependencies);

  let listener: GatewayListener | undefined;
  let listenPromise: Promise<{ host: typeof LOOPBACK_HOST; port: number }> | undefined;
  let closePromise: Promise<void> | undefined;

  const gateway: HostedGateway = {
    fetch(request: Request): Promise<Response> {
      if (closed) {
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      return Promise.resolve(app.fetch(request));
    },
    async listen(): Promise<{ host: typeof LOOPBACK_HOST; port: number }> {
      assertLoopbackBindHost(config.startup.host);
      if (listener !== undefined) {
        return await (listenPromise ?? Promise.resolve({ host: LOOPBACK_HOST, port: config.startup.port }));
      }
      const listen: GatewayListen = dependencies.listen ?? ((options) => serve(options));
      const current = listen({
        fetch: app.fetch,
        hostname: LOOPBACK_HOST,
        port: config.startup.port,
      });
      listener = current;
      listenPromise = current.listening
        ? Promise.resolve({ host: LOOPBACK_HOST, port: config.startup.port })
        : new Promise((resolve, reject) => {
          const cleanup = (): void => {
            current.off("listening", onListening);
            current.off("error", onError);
          };
          const onListening = (): void => {
            cleanup();
            resolve({ host: LOOPBACK_HOST, port: config.startup.port });
          };
          const onError = (error: Error): void => {
            cleanup();
            if (listener === current) {
              listener = undefined;
            }
            reject(error);
          };
          current.once("listening", onListening);
          current.once("error", onError);
        });
      return await listenPromise;
    },
    async close(): Promise<void> {
      closePromise ??= closeGateway();
      return await closePromise;
    },
  };

  async function closeGateway(): Promise<void> {
    closed = true;
    for (const controller of mountedInflight) {
      controller.abort();
    }
    mountedInflight.clear();
    admission.close();
    let closeError: unknown;
    try {
      dependencies.control?.close();
    } catch (error: unknown) {
      closeError ??= error;
    }
    try {
      dependencies.admin?.close();
    } catch (error: unknown) {
      closeError ??= error;
    }
    for (const request of inflight) {
      request.abortForShutdown();
    }
    inflight.clear();
    const current = listener;
    listener = undefined;
    listenPromise = undefined;

    const graceful = (async () => {
      if (current !== undefined) {
        try {
          await new Promise<void>((resolve, reject) => {
            current.close((error?: Error) => {
              if (error !== undefined) {
                reject(error);
                return;
              }
              resolve();
            });
            current.closeIdleConnections?.();
          });
        } catch (error: unknown) {
          closeError ??= error;
        }
      }
      try {
        await dependencies.onClose?.();
      } catch (error: unknown) {
        closeError ??= error;
      }
      if (closeError !== undefined) {
        throw closeError;
      }
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      graceful.then(
        () => ({ timedOut: false as const }),
        (error: unknown) => ({ timedOut: false as const, error }),
      ),
      new Promise<{ readonly timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), GRACEFUL_SHUTDOWN_MS);
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (!result.timedOut) {
      if ("error" in result) {
        forceCleanup(current, dependencies);
        throw result.error;
      }
      return;
    }
    try {
      dependencies.onShutdownTimeout?.();
    } catch {
      // Timeout reporting cannot prevent forced cleanup.
    }
    forceCleanup(current, dependencies);
  }

  return gateway;
}

function forceCleanup(
  listener: GatewayListener | undefined,
  dependencies: Readonly<GatewayDependencies>,
): void {
  try {
    listener?.closeAllConnections?.();
  } catch {
    // Continue forcing the remaining resources closed.
  }
  try {
    void Promise.resolve(dependencies.onForceClose?.()).catch(() => undefined);
  } catch {
    // Shutdown must remain bounded even when forced cleanup fails.
  }
}

function defaultRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "")}`;
}
