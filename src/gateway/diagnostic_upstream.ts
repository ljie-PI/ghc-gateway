import type { UpstreamByteResponse, UpstreamByteStream } from "../copilot/upstream_types.js";
import type { RequestDiagnostics } from "../telemetry/diagnostics.js";

export function observeDiagnosticUpstream(
  upstream: UpstreamByteResponse,
  diagnostics: RequestDiagnostics | undefined,
): UpstreamByteResponse {
  if (diagnostics === undefined) return upstream;
  observeHeaders(upstream.status, diagnostics);
  diagnostics.bytes("upstream", upstream.body.byteLength);
  if (upstream.status >= 200 && upstream.status < 300) diagnostics.stage("upstream_output");
  return upstream;
}

export function observeDiagnosticStream(
  upstream: UpstreamByteStream,
  diagnostics: RequestDiagnostics | undefined,
): UpstreamByteStream {
  if (diagnostics === undefined) return upstream;
  observeHeaders(upstream.status, diagnostics);
  return {
    status: upstream.status,
    headers: upstream.headers,
    bytes: observedBytes(upstream.bytes, diagnostics),
    cancel: async () => await upstream.cancel(),
  };
}

function observeHeaders(status: number, diagnostics: RequestDiagnostics): void {
  diagnostics.set({ upstreamStatus: status });
  diagnostics.stage("upstream_headers", status >= 400 ? { code: "status_only" } : {});
}

async function* observedBytes(
  bytes: AsyncIterable<Uint8Array>,
  diagnostics: RequestDiagnostics,
): AsyncIterable<Uint8Array> {
  let first = true;
  for await (const value of bytes) {
    diagnostics.bytes("upstream", value.byteLength);
    if (first) {
      first = false;
      diagnostics.stage("upstream_output");
    }
    yield value;
  }
}
