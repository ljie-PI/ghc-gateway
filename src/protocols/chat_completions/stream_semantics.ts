import {
  failureFromSignal,
  GatewayFailureError,
} from "../../gateway/failures.js";
import {
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
} from "../../serialization/wire_json.js";
import type {
  ChatChunk,
  ChatStreamFrame,
} from "./types.js";

export function isSemanticChatChunk(chunk: Readonly<ChatChunk>): boolean {
  if (!isWireJsonObject(chunk.payload)) {
    return false;
  }
  const choices = memberValues(chunk.payload, "choices")[0];
  return isWireJsonArray(choices) && choices.items.length > 0;
}

export async function readThroughFirstSemanticChatFrame(
  frames: AsyncIterator<ChatStreamFrame>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<readonly ChatStreamFrame[]> {
  if (signal.aborted) {
    throw new GatewayFailureError(failureFromSignal(signal, {
      source: "parser",
      phase: "stream",
    }));
  }
  const buffered: ChatStreamFrame[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const semantic = (async () => {
    for (;;) {
      const next = await frames.next();
      if (next.done === true) {
        throw new GatewayFailureError({
          kind: "upstream_stream_truncated",
          source: "parser",
          phase: "stream",
        });
      }
      buffered.push(next.value);
      if (next.value.kind !== "chunk" || isSemanticChatChunk(next.value.chunk)) {
        return buffered;
      }
    }
  })();
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new GatewayFailureError({
      kind: "upstream_timeout",
      source: "parser",
      phase: "stream",
    })), timeoutMs);
    timer.unref?.();
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new GatewayFailureError(failureFromSignal(signal, {
      source: "parser",
      phase: "stream",
    })));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([semantic, timeout, aborted]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
