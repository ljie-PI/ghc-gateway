import type { GatewayActivity } from "../gateway/create_gateway.js";
import type {
  AdminMonitorEvent,
  AdminOperationalEvent,
  AdminTelemetry,
} from "../telemetry/admin.js";
import { ADMIN_EVENT_REPLAY_BATCH_SIZE } from "../telemetry/admin.js";
import { AdminApiError, type AdminManagementApi } from "./api.js";

export const ADMIN_EVENT_SUBSCRIBER_CAP = 8;
export const ADMIN_EVENT_QUEUE_CAP = 128;
export const ADMIN_EVENT_QUEUE_BYTES = 1_048_576;
export const ADMIN_EVENT_HEARTBEAT_MS = 15_000;

const encoder = new TextEncoder();

interface Subscriber {
  readonly queue: Array<{
    readonly bytes: Uint8Array;
    readonly counted: boolean;
    readonly eventId: bigint | null;
  }>;
  readonly abortController: AbortController;
  readonly callerSignal: AbortSignal;
  readonly signal: AbortSignal;
  readonly activity: GatewayActivity;
  readonly onAbort: () => void;
  readonly wake: () => void;
  readonly heartbeat: ReturnType<typeof setInterval>;
  replay: Uint8Array[];
  replayBytes: number;
  replayCursor: string | null;
  replayThrough: bigint | null;
  replayStarted: boolean;
  replayDone: boolean;
  initialFrame: Uint8Array | undefined;
  performancePending: boolean;
  queuedBytes: number;
  queuedEvents: number;
  waiting: (() => void) | undefined;
  latestLiveEventId: bigint | null;
  closed: boolean;
}

export class AdminEventStreamHub {
  private readonly subscribers = new Set<Subscriber>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(
    private readonly telemetry: AdminTelemetry,
    private readonly api: Pick<AdminManagementApi, "status">,
    private readonly setTimer: typeof setInterval = setInterval,
    private readonly clearTimer: typeof clearInterval = clearInterval,
  ) {
    this.unsubscribe = telemetry.subscribe((event) => this.publish(event));
  }

  activeSubscribers(): number {
    return this.subscribers.size;
  }

  async open(
    lastEventId: string | null,
    signal: AbortSignal,
    activity: GatewayActivity,
  ): Promise<Response> {
    if (this.closed || this.subscribers.size >= ADMIN_EVENT_SUBSCRIBER_CAP) {
      throw new AdminApiError("capacity_exceeded");
    }
    if (lastEventId !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(lastEventId)
      || !Number.isSafeInteger(Number(lastEventId)))) {
      throw new AdminApiError("validation_failed");
    }
    signal.throwIfAborted();

    let subscriber: Subscriber | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const wake = (): void => {
          const resolve = subscriber?.waiting;
          if (resolve !== undefined) {
            subscriber!.waiting = undefined;
            resolve();
          }
        };
        const onAbort = (): void => this.closeSubscriber(subscriber);
        const abortController = new AbortController();
        subscriber = {
          queue: [],
          abortController,
          callerSignal: signal,
          replay: [],
          replayBytes: 0,
          replayCursor: lastEventId,
          replayThrough: null,
          replayStarted: false,
          replayDone: lastEventId === null,
          initialFrame: undefined,
          performancePending: true,
          signal: abortController.signal,
          activity,
          onAbort,
          wake,
          heartbeat: this.setTimer(() => this.enqueue(subscriber, encoder.encode(": keep-alive\n\n"), false, null), ADMIN_EVENT_HEARTBEAT_MS),
          queuedBytes: 0,
          queuedEvents: 0,
          waiting: undefined,
          latestLiveEventId: null,
          closed: false,
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.subscribers.add(subscriber);
        if (subscriber.closed) {
          controller.close();
        }
      },
      pull: async (controller) => {
        const current = subscriber;
        if (current === undefined || current.closed) {
          controller.close();
          return;
        }
        let replayFrame: Uint8Array | undefined;
        try {
          replayFrame = await this.nextInitialFrame(current);
        } catch (error: unknown) {
          if (current.closed || current.signal.aborted) {
            controller.close();
            return;
          }
          this.closeSubscriber(current);
          throw error;
        }
        if (current.closed || current.signal.aborted) {
          controller.close();
          return;
        }
        if (replayFrame !== undefined) {
          controller.enqueue(replayFrame);
          return;
        }
        if (current.performancePending) {
          current.performancePending = false;
          try {
            controller.enqueue(performanceFrame(this.api.status(current.activity)));
          } catch (error: unknown) {
            this.closeSubscriber(current);
            throw error;
          }
          return;
        }
        if (current.queue.length === 0) {
          await new Promise<void>((resolve) => {
            current.waiting = resolve;
          });
        }
        if (current.closed || current.signal.aborted) {
          controller.close();
          return;
        }
        const frame = current.queue.shift();
        if (frame !== undefined) {
          if (frame.counted) {
            current.queuedEvents -= 1;
            current.queuedBytes -= frame.bytes.byteLength;
          }
          controller.enqueue(frame.bytes);
        }
      },
      cancel: () => this.closeSubscriber(subscriber),
    }, { highWaterMark: 0 });
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribe();
    for (const subscriber of [...this.subscribers]) {
      this.closeSubscriber(subscriber);
    }
  }

  private publish(event: Readonly<AdminMonitorEvent>): void {
    for (const subscriber of [...this.subscribers]) {
      let frame: Uint8Array;
      let eventId: bigint | null = null;
      if (event.kind === "operational") {
        eventId = BigInt(event.event.eventId);
        if ((subscriber.replayThrough !== null && eventId <= subscriber.replayThrough)
          || (subscriber.latestLiveEventId !== null && eventId <= subscriber.latestLiveEventId)) {
          continue;
        }
        subscriber.latestLiveEventId = eventId;
        frame = operationalFrame(event.event);
      } else {
        frame = performanceFrame(this.api.status(subscriber.activity));
      }
      this.enqueue(subscriber, frame, true, eventId);
    }
  }

  private enqueue(
    subscriber: Subscriber | undefined,
    frame: Uint8Array,
    counted: boolean,
    eventId: bigint | null,
  ): void {
    if (subscriber === undefined || subscriber.closed) {
      return;
    }
    if (!counted && (subscriber.queue.length > 0 || subscriber.replay.length > 0 || subscriber.performancePending)) {
      return;
    }
    if (counted && (subscriber.queuedEvents + subscriber.replay.length >= ADMIN_EVENT_QUEUE_CAP
      || subscriber.queuedBytes + subscriber.replayBytes + frame.byteLength > ADMIN_EVENT_QUEUE_BYTES)) {
      this.closeSubscriber(subscriber);
      return;
    }
    subscriber.queue.push({ bytes: frame, counted, eventId });
    if (counted) {
      subscriber.queuedEvents += 1;
      subscriber.queuedBytes += frame.byteLength;
    }
    subscriber.wake();
  }

  private closeSubscriber(subscriber: Subscriber | undefined): void {
    if (subscriber === undefined || subscriber.closed) {
      return;
    }
    subscriber.closed = true;
    this.clearTimer(subscriber.heartbeat);
    subscriber.callerSignal.removeEventListener("abort", subscriber.onAbort);
    if (!subscriber.signal.aborted) {
      subscriber.abortController.abort();
    }
    subscriber.queue.length = 0;
    subscriber.replay.length = 0;
    subscriber.replayBytes = 0;
    subscriber.queuedBytes = 0;
    subscriber.queuedEvents = 0;
    this.subscribers.delete(subscriber);
    subscriber.wake();
  }

  private async nextInitialFrame(subscriber: Subscriber): Promise<Uint8Array | undefined> {
    const buffered = subscriber.replay.shift();
    if (buffered !== undefined) {
      subscriber.replayBytes -= buffered.byteLength;
      return buffered;
    }
    if (subscriber.initialFrame !== undefined) {
      const frame = subscriber.initialFrame;
      subscriber.initialFrame = undefined;
      return frame;
    }
    if (subscriber.replayDone || subscriber.replayCursor === null) {
      return undefined;
    }

    const replay = await this.telemetry.replayEvents(subscriber.replayCursor, subscriber.signal);
    subscriber.signal.throwIfAborted();
    if (subscriber.closed) {
      return undefined;
    }
    if (!subscriber.replayStarted) {
      subscriber.replayStarted = true;
      subscriber.replayThrough = replay.latestEventId === null
        ? BigInt(subscriber.replayCursor)
        : BigInt(replay.latestEventId);
      this.discardReplayedLiveEvents(subscriber);
      if (!replay.found) {
        subscriber.replayDone = true;
        subscriber.initialFrame = resetFrame(replay.latestEventId);
        return this.nextInitialFrame(subscriber);
      }
    } else if (!replay.found) {
      subscriber.replayDone = true;
      subscriber.initialFrame = resetFrame(replay.latestEventId);
      return this.nextInitialFrame(subscriber);
    }

    const through = subscriber.replayThrough;
    const items = through === null
      ? []
      : replay.items
        .slice(0, ADMIN_EVENT_REPLAY_BATCH_SIZE)
        .filter((event) => BigInt(event.eventId) <= through);
    const frames = items.map(operationalFrame);
    const replayBytes = frames.reduce((total, frame) => total + frame.byteLength, 0);
    if (subscriber.queuedEvents + frames.length > ADMIN_EVENT_QUEUE_CAP
      || subscriber.queuedBytes + replayBytes > ADMIN_EVENT_QUEUE_BYTES) {
      this.closeSubscriber(subscriber);
      return undefined;
    }
    subscriber.replay = frames;
    subscriber.replayBytes = replayBytes;
    const last = items.at(-1);
    if (last !== undefined) {
      subscriber.replayCursor = last.eventId;
    }
    if (last === undefined || through === null || BigInt(last.eventId) >= through) {
      subscriber.replayDone = true;
    }
    const frame = subscriber.replay.shift();
    if (frame !== undefined) {
      subscriber.replayBytes -= frame.byteLength;
    }
    return frame;
  }

  private discardReplayedLiveEvents(subscriber: Subscriber): void {
    const through = subscriber.replayThrough;
    if (through === null) {
      return;
    }
    for (let index = subscriber.queue.length - 1; index >= 0; index -= 1) {
      const pending = subscriber.queue[index];
      if (pending !== undefined && pending.eventId !== null && pending.eventId <= through) {
        subscriber.queue.splice(index, 1);
        if (pending.counted) {
          subscriber.queuedEvents -= 1;
          subscriber.queuedBytes -= pending.bytes.byteLength;
        }
      }
    }
  }
}

function operationalFrame(event: AdminOperationalEvent): Uint8Array {
  return encoder.encode(`id: ${event.eventId}\nevent: operational\ndata: ${JSON.stringify({ kind: "operational", event })}\n\n`);
}

function performanceFrame(status: ReturnType<AdminManagementApi["status"]>): Uint8Array {
  return encoder.encode(`event: performance\ndata: ${JSON.stringify({ kind: "performance", status })}\n\n`);
}

function resetFrame(latestEventId: string | null): Uint8Array {
  return encoder.encode(`event: reset\ndata: ${JSON.stringify({ kind: "reset", reason: "history_unavailable", latestEventId })}\n\n`);
}
