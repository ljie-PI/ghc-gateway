export class CachedResource<T> {
  private value: T | null = null;
  private generation = 0;
  private active: { controller: AbortController; promise: Promise<T> } | null = null;

  constructor(
    private readonly read: (signal: AbortSignal) => Promise<T>,
    private readonly publish: (value: T | null) => void,
  ) {}

  replace(value: T | null): void {
    this.generation += 1;
    this.active?.controller.abort();
    this.active = null;
    this.value = value;
    this.publish(value);
  }

  load(refresh = false): Promise<T> {
    if (!refresh && this.value !== null) return Promise.resolve(this.value);
    if (this.active !== null) return this.active.promise;
    const generation = this.generation;
    const controller = new AbortController();
    const promise = this.read(controller.signal).then((value) => {
      if (generation !== this.generation) return this.currentOrAbort();
      this.value = value;
      this.publish(value);
      return value;
    }).catch((error: unknown) => {
      if (generation !== this.generation) return this.currentOrAbort();
      throw error;
    }).finally(() => {
      if (this.active?.promise === promise) this.active = null;
    });
    this.active = { controller, promise };
    return promise;
  }

  private currentOrAbort(): T {
    // A superseded read may use a newer mutation result, but never republish stale data.
    if (this.value !== null) return this.value;
    throw new DOMException("superseded", "AbortError");
  }
}
