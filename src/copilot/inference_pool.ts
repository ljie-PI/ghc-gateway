import type { Dispatcher } from "undici";

export interface InferencePoolLimits {
  readonly maxEntries: number;
  readonly connectionsPerEntry: number;
  readonly maxWaitersPerEntry: number;
  readonly idleTimeoutMs: number;
  readonly maxAcquisitionMs: number;
  readonly shutdownGraceMs: number;
}

export const DEFAULT_INFERENCE_POOL_LIMITS: InferencePoolLimits = {
  maxEntries: 16,
  connectionsPerEntry: 4,
  maxWaitersPerEntry: 16,
  idleTimeoutMs: 30_000,
  maxAcquisitionMs: 120_000,
  shutdownGraceMs: 2_000,
};

export interface InferencePoolInspection {
  readonly entries: number;
  readonly active: number;
  readonly waiters: number;
  readonly initializing: number;
  readonly draining: number;
  readonly limits: InferencePoolLimits;
}

export interface InferenceDispatcherLease {
  readonly dispatcher: Dispatcher;
  release(): void;
}

export interface InferenceConnectionProfile {
  readonly origin: string;
  readonly connectTimeoutMs: number;
}

export class InferencePoolSaturatedError extends Error {
  constructor() {
    super("upstream connection pool is saturated");
    this.name = "InferencePoolSaturatedError";
  }
}

export class InferencePoolAcquireTimeoutError extends Error {
  constructor() {
    super("upstream connection acquisition timed out");
    this.name = "InferencePoolAcquireTimeoutError";
  }
}

type DispatcherFactory = (
  profile: InferenceConnectionProfile,
  limits: InferencePoolLimits,
) => Dispatcher | Promise<Dispatcher>;

export class BoundedInferencePoolRegistry {
  private readonly entries = new Map<string, InferencePoolEntry>();
  private readonly draining = new Set<InferencePoolEntry>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly createDispatcher: DispatcherFactory,
    private readonly limits: InferencePoolLimits = DEFAULT_INFERENCE_POOL_LIMITS,
  ) {}

  async acquire(
    origin: string,
    connectTimeoutMs: number,
    signal: AbortSignal,
    requestTimeoutMs: number | undefined,
  ): Promise<InferenceDispatcherLease> {
    if (this.closed) {
      throw closedError();
    }
    const timeoutMs = Math.min(requestTimeoutMs ?? this.limits.maxAcquisitionMs, this.limits.maxAcquisitionMs);
    const deadlineMs = Date.now() + timeoutMs;
    const profile = { origin, connectTimeoutMs };
    const key = profileKey(profile);
    const entry = await this.entryFor(key, profile, signal, deadlineMs);
    const release = await entry.acquire(
      signal,
      remainingMs(deadlineMs),
    );
    try {
      const dispatcher = await entry.getDispatcher(signal, deadlineMs);
      return { dispatcher, release };
    } catch (error: unknown) {
      release();
      if (entry.failed && this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
      throw error;
    }
  }

  inspect(): InferencePoolInspection {
    const all = [...this.entries.values(), ...this.draining];
    return {
      entries: all.length,
      active: all.reduce((total, entry) => total + entry.activeCount, 0),
      waiters: all.reduce((total, entry) => total + entry.waiterCount, 0),
      initializing: all.filter((entry) => entry.initializing).length,
      draining: this.draining.size,
      limits: this.limits,
    };
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeEntries();
    return await this.closePromise;
  }

  private async closeEntries(): Promise<void> {
    if (this.closed && this.entries.size === 0 && this.draining.size === 0) {
      return;
    }
    this.closed = true;
    const entries = [...this.entries.values(), ...this.draining];
    this.entries.clear();
    for (const entry of entries) {
      this.draining.add(entry);
    }
    const closing = Promise.allSettled(entries.map(async (entry) => entry.close()));
    const completed = await bounded(closing, this.limits.shutdownGraceMs);
    if (!completed) {
      for (const entry of entries) {
        void entry.forceClose().catch(() => undefined);
      }
      this.draining.clear();
      return;
    }
    const results = await closing;
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "failed to close inference pools");
    }
    this.draining.clear();
  }

  forceClose(): void {
    this.closed = true;
    const entries = [...this.entries.values(), ...this.draining];
    this.entries.clear();
    this.draining.clear();
    for (const entry of entries) {
      void entry.forceClose();
    }
  }

  private async entryFor(
    key: string,
    profile: InferenceConnectionProfile,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<InferencePoolEntry> {
    for (;;) {
      signal.throwIfAborted();
      if (this.closed) {
        throw closedError();
      }
      const existing = this.entries.get(key);
      if (existing !== undefined) {
        existing.touch();
        return existing;
      }
      if (this.entries.size + this.draining.size < this.limits.maxEntries) {
        const created = new InferencePoolEntry(
          key,
          profile,
          this.createDispatcher,
          this.limits,
          (entry) => this.scheduleIdleEviction(entry),
        );
        this.entries.set(key, created);
        return created;
      }
      const idle = [...this.entries.values()]
        .filter((entry) => entry.idle)
        .sort((left, right) => left.lastUsedMs - right.lastUsedMs)[0];
      if (idle === undefined) {
        throw new InferencePoolSaturatedError();
      }
      this.entries.delete(idle.key);
      if (!await this.beginDraining(idle, remainingMs(deadlineMs))) {
        throw new InferencePoolAcquireTimeoutError();
      }
    }
  }

  private scheduleIdleEviction(entry: InferencePoolEntry): void {
    entry.scheduleIdle(() => {
      if (this.closed || this.entries.get(entry.key) !== entry || !entry.idle) {
        return;
      }
      this.entries.delete(entry.key);
      void this.beginDraining(entry, this.limits.shutdownGraceMs);
    });
  }

  private async beginDraining(entry: InferencePoolEntry, graceMs: number): Promise<boolean> {
    this.draining.add(entry);
    const graceful = Promise.allSettled([entry.close()]);
    const completed = await bounded(graceful, graceMs);
    if (completed) {
      const [result] = await graceful;
      if (result?.status === "fulfilled") {
        this.draining.delete(entry);
        return true;
      }
    }
    const forced = entry.forceClose();
    void forced.finally(() => this.draining.delete(entry));
    return false;
  }
}

interface PoolWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

class InferencePoolEntry {
  private dispatcher: Dispatcher | undefined;
  private dispatcherPromise: Promise<Dispatcher> | undefined;
  private closingDispatcher: Dispatcher | undefined;
  private readonly waiters: PoolWaiter[] = [];
  private active = 0;
  private closed = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private failedInitialization = false;
  private closePromise: Promise<void> | undefined;
  private closingDispatcherPromise: Promise<Dispatcher> | undefined;
  private forceClosed = false;
  lastUsedMs = Date.now();

  constructor(
    readonly key: string,
    private readonly profile: InferenceConnectionProfile,
    private readonly createDispatcher: DispatcherFactory,
    private readonly limits: InferencePoolLimits,
    private readonly onIdle: (entry: InferencePoolEntry) => void,
  ) {}

  get activeCount(): number {
    return this.active;
  }

  get waiterCount(): number {
    return this.waiters.length;
  }

  get initializing(): boolean {
    return this.dispatcherPromise !== undefined;
  }

  get failed(): boolean {
    return this.failedInitialization;
  }

  get idle(): boolean {
    return this.active === 0 && this.waiters.length === 0 && this.dispatcherPromise === undefined;
  }

  touch(): void {
    this.lastUsedMs = Date.now();
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  scheduleIdle(evict: () => void): void {
    this.touch();
    if (!this.idle || this.closed) {
      return;
    }
    this.idleTimer = setTimeout(evict, this.limits.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  async acquire(signal: AbortSignal, timeoutMs: number): Promise<() => void> {
    signal.throwIfAborted();
    if (this.closed) {
      throw closedError();
    }
    this.touch();
    if (this.active < this.limits.connectionsPerEntry) {
      this.active += 1;
      return this.releaseOnce();
    }
    if (this.waiters.length >= this.limits.maxWaitersPerEntry) {
      throw new InferencePoolSaturatedError();
    }
    return await new Promise<() => void>((resolve, reject) => {
      const onAbort = (): void => {
        remove();
        reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      };
      const remove = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      const waiter: PoolWaiter = {
        resolve,
        reject,
        cleanup: remove,
      };
      const timer = setTimeout(() => {
        remove();
        reject(new InferencePoolAcquireTimeoutError());
      }, Math.max(1, timeoutMs));
      timer.unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  async getDispatcher(signal: AbortSignal, deadlineMs: number): Promise<Dispatcher> {
    if (this.closed) {
      throw closedError();
    }
    if (this.dispatcher !== undefined) {
      return this.dispatcher;
    }
    const pending = this.dispatcherPromise ?? this.startDispatcher();
    const dispatcher = await waitForDispatcher(pending, signal, deadlineMs);
    if (this.closed) {
      throw closedError();
    }
    return dispatcher;
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeDispatcher();
    return await this.closePromise;
  }

  private async closeDispatcher(): Promise<void> {
    if (this.closed && this.dispatcher === undefined && this.dispatcherPromise === undefined) {
      return;
    }
    this.closed = true;
    this.clearIdleTimer();
    this.rejectWaiters();
    const pending = this.dispatcherPromise;
    this.dispatcherPromise = undefined;
    this.closingDispatcherPromise = pending;
    const dispatcher = this.dispatcher ?? await pending?.catch(() => undefined);
    this.closingDispatcherPromise = undefined;
    this.dispatcher = undefined;
    if (dispatcher !== undefined && !this.forceClosed) {
      this.closingDispatcher = dispatcher;
      await dispatcher.close();
      if (this.closingDispatcher === dispatcher) {
        this.closingDispatcher = undefined;
      }
    }
  }

  async forceClose(): Promise<void> {
    this.forceClosed = true;
    this.closed = true;
    this.clearIdleTimer();
    this.rejectWaiters();
    const pending = this.dispatcherPromise ?? this.closingDispatcherPromise;
    this.dispatcherPromise = undefined;
    this.closingDispatcherPromise = undefined;
    const dispatcher = this.dispatcher ?? this.closingDispatcher;
    this.dispatcher = undefined;
    this.closingDispatcher = undefined;
    await Promise.allSettled([
      ...(dispatcher === undefined ? [] : [dispatcher.destroy()]),
      ...(pending === undefined ? [] : [pending.then(async (created) => created.destroy())]),
    ]);
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.lastUsedMs = Date.now();
      const waiter = this.waiters.shift();
      if (waiter !== undefined) {
        waiter.cleanup();
        waiter.resolve(this.releaseOnce());
        return;
      }
      this.active = Math.max(0, this.active - 1);
      if (this.idle) {
        this.onIdle(this);
      }
    };
  }

  private rejectWaiters(): void {
    const error = closedError();
    for (const waiter of this.waiters.splice(0)) {
      waiter.cleanup();
      waiter.reject(error);
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private startDispatcher(): Promise<Dispatcher> {
    const pending = Promise.resolve()
      .then(async () => this.createDispatcher(this.profile, this.limits))
      .then((created) => {
        this.failedInitialization = false;
        if (!this.closed) {
          this.dispatcher ??= created;
          return this.dispatcher;
        }
        return created;
      }, (error: unknown) => {
        this.failedInitialization = true;
        throw error;
      })
      .finally(() => {
        if (this.dispatcherPromise === pending) {
          this.dispatcherPromise = undefined;
        }
        if (this.idle) {
          this.onIdle(this);
        }
      });
    this.dispatcherPromise = pending;
    return pending;
  }
}

function closedError(): DOMException {
  return new DOMException("closed", "AbortError");
}

async function bounded(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function remainingMs(deadlineMs: number): number {
  return Math.max(1, deadlineMs - Date.now());
}

function profileKey(profile: InferenceConnectionProfile): string {
  return `${profile.origin}\n${profile.connectTimeoutMs}`;
}

async function waitForDispatcher(
  pending: Promise<Dispatcher>,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<Dispatcher> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = (): void => undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => reject(signal.reason ?? closedError());
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        timer = setTimeout(
          () => reject(new InferencePoolAcquireTimeoutError()),
          remainingMs(deadlineMs),
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    removeAbortListener();
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
