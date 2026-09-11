export interface StreamResponseWriter {
  readonly committed: boolean;
  enqueue(chunk: Uint8Array): Promise<boolean>;
  close(): void;
  abort(error?: unknown): void;
  readonly response: Response;
}

export function createStreamResponseWriter(init: {
  readonly status?: number;
  readonly headers?: HeadersInit;
  readonly onCommit?: () => void;
  readonly onCancel?: () => Promise<void> | void;
}): StreamResponseWriter {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let committed = false;
  let closed = false;
  let outstandingPulls = 0;
  let lookahead: Uint8Array | undefined;
  let waitingProducer: (() => void) | undefined;
  let settleLookahead: ((accepted: boolean) => void) | undefined;
  let cancellation: Promise<void> | undefined;

  const cancelProducer = async (): Promise<void> => {
    cancellation ??= Promise.resolve().then(() => init.onCancel?.());
    await cancellation;
  };

  const deliver = (chunk: Uint8Array): void => {
    committed = true;
    controller?.enqueue(chunk);
    init.onCommit?.();
    const settle = settleLookahead;
    settleLookahead = undefined;
    settle?.(true);
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
      const settle = settleLookahead;
      settleLookahead = undefined;
      settle?.(false);
      wakeProducer();
      await cancelProducer();
    },
  }, { highWaterMark: 0 });

  const writer: StreamResponseWriter = {
    get committed(): boolean {
      return committed;
    },
    async enqueue(chunk: Uint8Array): Promise<boolean> {
      if (closed) {
        return false;
      }
      while (!closed && lookahead !== undefined) {
        await new Promise<void>((resolve) => {
          waitingProducer = resolve;
        });
      }
      if (closed) {
        return false;
      }
      if (outstandingPulls > 0) {
        outstandingPulls -= 1;
        deliver(chunk);
        return true;
      }
      lookahead = chunk;
      return await new Promise<boolean>((resolve) => {
        settleLookahead = resolve;
      });
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
    abort(error = new Error("aborted")): void {
      closed = true;
      lookahead = undefined;
      const settle = settleLookahead;
      settleLookahead = undefined;
      settle?.(false);
      try {
        controller?.error(error);
      } catch (_error) {
        // already closed
      }
      wakeProducer();
    },
    response: new Response(stream, init.headers === undefined
      ? { status: init.status ?? 200 }
      : { status: init.status ?? 200, headers: init.headers }),
  };

  return writer;
}
