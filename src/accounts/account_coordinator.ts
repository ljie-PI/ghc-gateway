export interface AccountCoordinatorInspection {
  readonly stopped: boolean;
  readonly idle: boolean;
  readonly lifecyclePending: number;
  readonly generationKeys: number;
  readonly generationPending: number;
}

interface QueueNode<T> {
  readonly work: () => Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  readonly signal?: AbortSignal;
  onAbort: (() => void) | undefined;
}

class CoordinationLane {
  private active = false;
  private readonly queue: QueueNode<unknown>[] = [];

  constructor(private readonly onChange: (lane: CoordinationLane) => void) {}

  get pending(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    return new Promise<T>((resolve, reject) => {
      const node: QueueNode<T> = {
        work,
        resolve,
        reject,
        onAbort: undefined,
        ...(signal === undefined ? {} : { signal }),
      };
      if (this.active) {
        const queued = node as QueueNode<unknown>;
        const onAbort = (): void => {
          const index = this.queue.indexOf(queued);
          if (index === -1) {
            return;
          }
          this.queue.splice(index, 1);
          signal?.removeEventListener("abort", onAbort);
          queued.onAbort = undefined;
          reject(abortError());
          this.onChange(this);
        };
        node.onAbort = onAbort;
        signal?.addEventListener("abort", onAbort, { once: true });
        this.queue.push(queued);
        this.onChange(this);
        return;
      }
      this.active = true;
      this.onChange(this);
      this.admit(node as QueueNode<unknown>);
    });
  }

  private admit(node: QueueNode<unknown>): void {
    if (node.onAbort !== undefined) {
      node.signal?.removeEventListener("abort", node.onAbort);
      node.onAbort = undefined;
    }
    void (async () => {
      try {
        node.resolve(await node.work());
      } catch (error: unknown) {
        node.reject(error);
      } finally {
        this.active = false;
        const next = this.queue.shift();
        if (next !== undefined) {
          this.active = true;
        }
        this.onChange(this);
        if (next !== undefined) {
          this.admit(next);
        }
      }
    })();
  }
}

/** Coordinates account mutations owned by one application context. */
export class AccountCoordinator {
  private stopped = false;
  private readonly lifecycle: CoordinationLane;
  private readonly generations = new Map<string, CoordinationLane>();
  private readonly drainWaiters = new Set<() => void>();

  constructor() {
    this.lifecycle = new CoordinationLane(() => this.changed());
  }

  async withLifecycle<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.requireRunning();
    return await this.lifecycle.run(work, signal);
  }

  async withCredentialGeneration<T>(accountId: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.requireRunning();
    throwIfAborted(signal);
    let lane = this.generations.get(accountId);
    if (lane === undefined) {
      lane = new CoordinationLane((changedLane) => this.generationChanged(accountId, changedLane));
      this.generations.set(accountId, lane);
    }
    try {
      return await lane.run(work, signal);
    } catch (error: unknown) {
      if (lane.pending === 0 && this.generations.get(accountId) === lane) {
        this.generations.delete(accountId);
      }
      throw error;
    }
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.changed();
  }

  async close(): Promise<void> {
    this.stop();
    await this.drain();
  }

  drain(): Promise<void> {
    if (this.isIdle()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  isIdle(): boolean {
    return this.lifecycle.pending === 0 && this.generations.size === 0;
  }

  inspect(): AccountCoordinatorInspection {
    let generationPending = 0;
    for (const lane of this.generations.values()) {
      generationPending += lane.pending;
    }
    return {
      stopped: this.stopped,
      idle: this.lifecycle.pending === 0 && generationPending === 0,
      lifecyclePending: this.lifecycle.pending,
      generationKeys: this.generations.size,
      generationPending,
    };
  }

  private requireRunning(): void {
    if (this.stopped) {
      throw new DOMException("account coordinator is closed", "InvalidStateError");
    }
  }

  private generationChanged(accountId: string, lane: CoordinationLane): void {
    if (lane.pending === 0 && this.generations.get(accountId) === lane) {
      this.generations.delete(accountId);
    }
    this.changed();
  }

  private changed(): void {
    if (!this.isIdle()) {
      return;
    }
    for (const resolve of this.drainWaiters) {
      resolve();
    }
    this.drainWaiters.clear();
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw abortError();
  }
}

function abortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}
