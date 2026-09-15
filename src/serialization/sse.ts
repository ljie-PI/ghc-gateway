export class SseDecodeError extends Error {
  readonly code: "event_too_large" | "invalid_utf8" | "truncated";

  constructor(code: SseDecodeError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SseDecodeError";
    this.code = code;
  }
}
