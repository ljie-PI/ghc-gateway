import { EndpointDiscovery } from "../../../src/copilot/endpoint_discovery.js";
import { HttpCopilotBackend, type CopilotTransportDeps } from "../../../src/copilot/transport.js";
import { startCopilotHttpMock, type HttpExpectation } from "./copilot_http.js";

/** Compose the production transport, with synthetic credentials supplied by the caller. */
export async function startHttpCopilot(options: {
  readonly credentials: CopilotTransportDeps["credentials"];
  readonly accountCoordinator: CopilotTransportDeps["accountCoordinator"];
  readonly nowMs: () => number;
  readonly refreshCopilotToken?: CopilotTransportDeps["refreshCopilotToken"];
  readonly expectations?: readonly HttpExpectation[];
}) {
  return await withSetupCleanup(async (own) => {
    const upstream = await startCopilotHttpMock({ expectations: options.expectations ?? [] });
    own(() => upstream.stop());
    const discovery = new EndpointDiscovery(async () => upstream.origin);
    own(() => discovery.close());
    const backend = new HttpCopilotBackend({
      ...options,
      endpointDiscovery: discovery,
      // Distinguishable synthetic credentials preserve Bound Account evidence on the wire.
      refreshCopilotToken: options.refreshCopilotToken ?? (async (token) => ({
        token: `http-test-${token}`, expiresAtMs: options.nowMs() + 3_600_000,
      })),
    });
    own(() => backend.close());
    return {
      upstream, backend,
      async close() {
        await closeAll([() => assertTransportReleased(backend), () => backend.close(), () => discovery.close(), () => upstream.stop()]);
        upstream.assertHealthy();
      },
    };
  });
}

/** Roll back partially constructed fixtures; successful fixtures retain their explicit close order. */
export async function withSetupCleanup<T>(
  build: (own: (close: () => unknown | Promise<unknown>) => void) => Promise<T>,
): Promise<T> {
  const closers: (() => unknown | Promise<unknown>)[] = [];
  try {
    return await build((close) => { closers.push(close); });
  } catch (error: unknown) {
    await closeAll(closers.reverse());
    throw error;
  }
}

/** Match dispatch using the actual HTTP JSON body, not backend operation metadata. */
export function jsonStream(stream: boolean): (body: Uint8Array) => boolean {
  return (body) => {
    const value = JSON.parse(new TextDecoder().decode(body)) as { stream?: unknown };
    return (value.stream === true) === stream;
  };
}

/** Continue releasing every owned resource even if one closer fails. */
export async function closeAll(closers: readonly (() => unknown | Promise<unknown>)[]): Promise<void> {
  let failed = false;
  for (const close of closers) {
    try { await close(); } catch { failed = true; }
  }
  if (failed) throw new Error("HTTP fixture cleanup failed");
}

export async function waitForHttp(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("HTTP fixture barrier timed out");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export function assertTransportReleased(backend: HttpCopilotBackend): void {
  const state = backend.inspect();
  if (state.responseLeases !== 0 || state.pools.active !== 0 || state.pools.waiters !== 0) {
    throw new Error("HTTP fixture transport still leased");
  }
}
