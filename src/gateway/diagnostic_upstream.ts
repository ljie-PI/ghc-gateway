import type { UpstreamByteResponse, UpstreamByteStream } from "../copilot/upstream_types.js";
import type { RequestDiagnostics } from "../telemetry/diagnostics.js";

export function observeDiagnosticUpstream(
  upstream: UpstreamByteResponse,
  diagnostics: RequestDiagnostics | undefined,
): UpstreamByteResponse {
  if (diagnostics === undefined) return upstream;
  observeHeaders(upstream.status, diagnostics, upstream.status >= 400 ? upstream.body : undefined);
  diagnostics.bytes("upstream", upstream.body.byteLength);
  if (upstream.status >= 200 && upstream.status < 300) diagnostics.stage("upstream_output");
  return upstream;
}

export function observeDiagnosticStream(
  upstream: UpstreamByteStream,
  diagnostics: RequestDiagnostics | undefined,
): UpstreamByteStream {
  if (diagnostics === undefined) return upstream;
  observeHeaders(upstream.status, diagnostics, upstream.errorBody);
  return {
    status: upstream.status,
    headers: upstream.headers,
    bytes: observedBytes(upstream.bytes, diagnostics),
    ...(upstream.errorBody === undefined ? {} : { errorBody: upstream.errorBody }),
    cancel: async () => await upstream.cancel(),
  };
}

function observeHeaders(status: number, diagnostics: RequestDiagnostics, errorBody: Uint8Array | undefined): void {
  diagnostics.set({ upstreamStatus: status });
  if (status < 400) {
    diagnostics.stage("upstream_headers");
    return;
  }
  const error = upstreamErrorIdentifiers(errorBody);
  diagnostics.stage("upstream_headers", error === undefined ? { code: "status_only" } : error);
}

/**
 * Reads only the OpenAI `error.type`/`error.code` or Anthropic `error.type` identifiers from a rejected
 * body; diagnostics sanitization drops anything that is not identifier-shaped.
 */
function upstreamErrorIdentifiers(
  body: Uint8Array | undefined,
): { readonly upstreamErrorType?: string; readonly upstreamErrorCode?: string } | undefined {
  if (body === undefined || body.byteLength === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: false }).decode(body));
  } catch {
    return undefined;
  }
  const error = parsed !== null && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
  if (error === null || typeof error !== "object") return undefined;
  const { type, code } = error as { type?: unknown; code?: unknown };
  const result = {
    ...(typeof type === "string" ? { upstreamErrorType: type } : {}),
    ...(typeof code === "string" ? { upstreamErrorCode: code } : {}),
  };
  return Object.keys(result).length === 0 ? undefined : result;
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
