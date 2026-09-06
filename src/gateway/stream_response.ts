export interface StreamResponseWriter {
  readonly committed: boolean;
  enqueue(chunk: Uint8Array): Promise<boolean>;
  close(): void;
  abort(): void;
  readonly response: Response;
}

export function createStreamResponseWriter(init: {
  readonly status?: number;
  readonly headers?: HeadersInit;
  readonly signal: AbortSignal;
  readonly onCancel?: () => Promise<void> | void;
}): StreamResponseWriter {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let committed = false;
  let closed = false;
  let outstandingPulls = 0;
  let lookahead: Uint8Array | undefined;
  let waitingProducer: (() => void) | undefined;

  const deliver = (chunk: Uint8Array): void => {
    committed = true;
    controller?.enqueue(chunk);
  };

  const wakeProducer = (): void => {
    const waiter = waitingProducer;
    waitingProducer = undefined;
    waiter?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(streamController): void {
      controller = streamController;
    },
    pull(): void {
      if (lookahead !== undefined) {
        const chunk = lookahead;
        lookahead = undefined;
        deliver(chunk);
        wakeProducer();
        return;
      }
      outstandingPulls += 1;
      wakeProducer();
    },
    async cancel(): Promise<void> {
      closed = true;
      lookahead = undefined;
      wakeProducer();
      await init.onCancel?.();
    },
  });

  const writer: StreamResponseWriter = {
    get committed(): boolean {
      return committed;
    },
    async enqueue(chunk: Uint8Array): Promise<boolean> {
      if (closed || init.signal.aborted) {
        return false;
      }
      while (!closed && !init.signal.aborted && lookahead !== undefined) {
        await new Promise<void>((resolve) => {
          waitingProducer = resolve;
        });
      }
      if (closed || init.signal.aborted) {
        return false;
      }
      if (outstandingPulls > 0) {
        outstandingPulls -= 1;
        deliver(chunk);
        return true;
      }
      lookahead = chunk;
      return true;
    },
    close(): void {
      closed = true;
      if (lookahead !== undefined) {
        deliver(lookahead);
        lookahead = undefined;
      }
      try {
        controller?.close();
      } catch (_error) {
        // already closed
      }
      wakeProducer();
    },
    abort(): void {
      closed = true;
      lookahead = undefined;
      try {
        controller?.error(new Error("aborted"));
      } catch (_error) {
        // already closed
      }
      wakeProducer();
    },
    response: new Response(stream, init.headers === undefined
      ? { status: init.status ?? 200 }
      : { status: init.status ?? 200, headers: init.headers }),
  };

  init.signal.addEventListener("abort", () => {
    writer.abort();
  }, { once: true });

  return writer;
}
