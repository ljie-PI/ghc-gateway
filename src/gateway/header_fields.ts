export interface OrderedHeaderField {
  readonly name: string;
  readonly value: string;
}

export type OrderedHeaderFields = readonly Readonly<OrderedHeaderField>[];

export type CapturedHeaderFields =
  | { readonly ok: true; readonly fields: OrderedHeaderFields }
  | { readonly ok: false };

export const MAX_INBOUND_HEADER_FIELDS = 128;
export const MAX_INBOUND_HEADER_BYTES = 16 * 1024;
export const NODE_MAX_HEADER_BYTES = 32 * 1024;

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const CONNECTION_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

export function captureRawHeaderFields(rawHeaders: readonly string[]): CapturedHeaderFields {
  if (rawHeaders.length % 2 !== 0 || rawHeaders.length / 2 > MAX_INBOUND_HEADER_FIELDS) {
    return { ok: false };
  }

  const fields: OrderedHeaderField[] = [];
  let bytes = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name === undefined || value === undefined || !validHeaderName(name) || !validHeaderValue(value)) {
      return { ok: false };
    }
    if (name.toLowerCase() === "connection" && !validConnectionValue(value)) return { ok: false };
    bytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
    if (bytes > MAX_INBOUND_HEADER_BYTES) {
      return { ok: false };
    }
    fields.push(Object.freeze({ name, value }));
  }
  return { ok: true, fields: Object.freeze(fields) };
}

export function captureNormalizedHeaderFields(headers: Headers): CapturedHeaderFields {
  const fields: OrderedHeaderField[] = [];
  let bytes = 0;
  let valid = true;
  headers.forEach((value, name) => {
    if (!valid) {
      return;
    }
    bytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
    if (
      fields.length >= MAX_INBOUND_HEADER_FIELDS
      || bytes > MAX_INBOUND_HEADER_BYTES
      || !validHeaderName(name)
      || !validHeaderValue(value)
      || (name.toLowerCase() === "connection" && !validConnectionValue(value))
    ) {
      valid = false;
      return;
    }
    fields.push(Object.freeze({ name, value }));
  });
  return valid ? { ok: true, fields: Object.freeze(fields) } : { ok: false };
}

export function validHeaderName(name: string): boolean {
  return HEADER_NAME.test(name) || /^:[a-z0-9-]+$/u.test(name);
}

export function validHeaderValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      return false;
    }
  }
  return true;
}

function validConnectionValue(value: string): boolean {
  const tokens = value.split(",");
  return tokens.length > 0 && tokens.every((token) => CONNECTION_TOKEN.test(token.trim()));
}
