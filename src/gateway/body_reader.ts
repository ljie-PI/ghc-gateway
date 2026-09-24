import {
  parseWireJson,
  WireJsonError,
  isWireJsonObject,
  type WireJsonObject,
} from "../serialization/wire_json.js";
import { GatewayFailureError } from "./failures.js";

const JSON_MEDIA_TYPE = "application/json";
const UTF8 = "utf-8";

export async function readWireJsonObjectBody(
  request: Request,
  maxBytes: number,
  signal: AbortSignal,
): Promise<WireJsonObject> {
  assertJsonMediaType(request.headers);
  assertIdentityEncoding(request.headers);

  const bytes = await readLimitedBytes(request, maxBytes, signal);
  if (bytes.byteLength === 0) {
    throw new GatewayFailureError({ kind: "invalid_request" });
  }

  try {
    const value = parseWireJson(bytes, { maxBytes, maxDepth: 64 });
    if (!isWireJsonObject(value)) {
      throw new GatewayFailureError({ kind: "invalid_request" });
    }
    return value;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    if (error instanceof WireJsonError && error.code === "byte_limit") {
      throw new GatewayFailureError({ kind: "body_too_large", cause: error });
    }
    throw new GatewayFailureError({ kind: "invalid_request", cause: error });
  }
}

export function assertJsonMediaType(headers: Headers): void {
  const raw = headers.get("content-type");
  if (raw === null || raw.includes(",")) {
    throw new GatewayFailureError({ kind: "unsupported_media_type" });
  }

  const parsed = parseContentType(raw);
  if (parsed === undefined || parsed.mediaType !== JSON_MEDIA_TYPE) {
    throw new GatewayFailureError({ kind: "unsupported_media_type" });
  }
  if (parsed.charset !== undefined && parsed.charset !== UTF8) {
    throw new GatewayFailureError({ kind: "unsupported_media_type" });
  }
}

function assertIdentityEncoding(headers: Headers): void {
  const raw = headers.get("content-encoding");
  if (raw === null) {
    return;
  }
  const values = raw.split(",").map((part) => part.trim().toLowerCase()).filter((part) => part.length > 0);
  if (values.length !== 1 || values[0] !== "identity") {
    throw new GatewayFailureError({ kind: "unsupported_media_type" });
  }
}

async function readLimitedBytes(request: Request, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/u.test(declared)) {
    const length = Number.parseInt(declared, 10);
    if (length > maxBytes) {
      throw new GatewayFailureError({ kind: "body_too_large" });
    }
  }

  const body = request.body;
  if (body === null) {
    const buffered = new Uint8Array(await withAbort(request.arrayBuffer(), signal));
    if (buffered.byteLength > maxBytes) {
      throw new GatewayFailureError({ kind: "body_too_large" });
    }
    return buffered;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await readNext(reader, signal);
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new GatewayFailureError({ kind: "body_too_large" });
      }
      chunks.push(value);
    }
  } finally {
    if (signal.aborted) {
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  function readNext(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    return withAbort(reader.read(), signal, () => {
      void reader.cancel().catch(() => undefined);
    });
  }

  function withAbort<T>(work: Promise<T>, signal: AbortSignal, onAbort?: () => void): Promise<T> {
    if (signal.aborted) {
      onAbort?.();
      return Promise.reject(new GatewayFailureError({ kind: "aborted" }));
    }
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        onAbort?.();
        reject(new GatewayFailureError({ kind: "aborted" }));
      };
      signal.addEventListener("abort", abort, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }
  return bytes;
}

function parseContentType(raw: string): { mediaType: string; charset?: string } | undefined {
  const parts = raw.split(";").map((part) => part.trim());
  const media = parts[0]?.toLowerCase();
  if (media === undefined || media.length === 0) {
    return undefined;
  }
  let charset: string | undefined;
  for (const parameter of parts.slice(1)) {
    const eq = parameter.indexOf("=");
    if (eq <= 0) {
      return undefined;
    }
    const name = parameter.slice(0, eq).trim().toLowerCase();
    let value = parameter.slice(eq + 1).trim();
    if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (name === "charset") {
      charset = value.toLowerCase();
    }
  }
  return charset === undefined ? { mediaType: media } : { mediaType: media, charset };
}
