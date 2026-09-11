import type { BoundAccount } from "../accounts/account_directory.js";
import { STRIP_ON_CROSS_HOST } from "./identity.js";

export const GITHUB_COM_FALLBACK = "https://api.githubcopilot.com";
export const MAX_REDIRECTS = 10;

export interface DiscoveredEndpoint {
  readonly endpoint: string;
  readonly cached: boolean;
}

export type EndpointDiscoveryFetch = (
  account: Readonly<BoundAccount>,
  signal?: AbortSignal,
) => Promise<string | null>;

interface DiscoveryLane {
  readonly credentialGeneration: number;
  endpoint?: string;
  operation?: DiscoveryOperation;
}

interface DiscoveryOperation {
  readonly controller: AbortController;
  completion: Promise<string>;
  settled: boolean;
  waiters: number;
}

export class EndpointDiscovery {
  private readonly lanes = new Map<string, DiscoveryLane>();
  private readonly joins = new Map<string, Map<number, DiscoveryOperation>>();
  private readonly operations = new Set<DiscoveryOperation>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly fetchDiscovery: EndpointDiscoveryFetch) {}

  async discover(
    account: Readonly<BoundAccount>,
    signal?: AbortSignal,
  ): Promise<DiscoveredEndpoint> {
    throwIfAborted(signal);
    if (this.closed) {
      throw closedError();
    }
    const current = this.lanes.get(account.accountId);
    if (current?.credentialGeneration === account.credentialGeneration && current.endpoint !== undefined) {
      return { endpoint: current.endpoint, cached: true };
    }
    let lane: DiscoveryLane;
    if (current === undefined || account.credentialGeneration > current.credentialGeneration) {
      lane = { credentialGeneration: account.credentialGeneration };
      this.lanes.set(account.accountId, lane);
    } else if (current.credentialGeneration === account.credentialGeneration) {
      lane = current;
    } else {
      lane = { credentialGeneration: account.credentialGeneration };
    }
    const operation = this.joinFor(account) ?? this.startOperation(account, lane);
    const endpoint = await waitForOperation(operation, signal, () => {
      this.removeJoin(account, operation);
      if (lane.operation === operation) {
        delete lane.operation;
      }
      if (this.lanes.get(account.accountId) === lane) {
        this.lanes.delete(account.accountId);
      }
      operation.controller.abort();
    });
    return { endpoint, cached: false };
  }

  invalidate(accountId: string): void {
    this.lanes.delete(accountId);
    this.joins.delete(accountId);
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeDiscovery();
    await this.closePromise;
  }

  forceClose(): void {
    this.closed = true;
    this.lanes.clear();
    this.joins.clear();
    for (const operation of this.operations) {
      operation.controller.abort();
    }
    this.operations.clear();
  }

  private async closeDiscovery(): Promise<void> {
    this.closed = true;
    this.lanes.clear();
    this.joins.clear();
    const operations = [...this.operations];
    for (const operation of operations) {
      operation.controller.abort();
    }
    await Promise.allSettled(operations.map(async (operation) => await operation.completion));
  }

  private startOperation(account: Readonly<BoundAccount>, lane: DiscoveryLane): DiscoveryOperation {
    const controller = new AbortController();
    const operation: DiscoveryOperation = {
      controller,
      completion: Promise.resolve(fallbackEndpoint(account)),
      settled: false,
      waiters: 0,
    };
    lane.operation = operation;
    let accountJoins = this.joins.get(account.accountId);
    if (accountJoins === undefined) {
      accountJoins = new Map<number, DiscoveryOperation>();
      this.joins.set(account.accountId, accountJoins);
    }
    accountJoins.set(account.credentialGeneration, operation);
    this.operations.add(operation);
    let source: Promise<string | null>;
    try {
      source = this.fetchDiscovery(account, controller.signal);
    } catch (error: unknown) {
      source = Promise.reject(error);
    }
    operation.completion = waitForSource(source, controller.signal).then((discovered) => {
      if (this.closed) {
        throw closedError();
      }
      const endpoint = discovered ?? fallbackEndpoint(account);
      if (this.lanes.get(account.accountId) === lane
        && lane.operation === operation
        && !controller.signal.aborted) {
        lane.endpoint = endpoint;
      }
      return endpoint;
    }).finally(() => {
      operation.settled = true;
      this.operations.delete(operation);
      this.removeJoin(account, operation);
      if (lane.operation === operation) {
        delete lane.operation;
      }
    });
    return operation;
  }

  private joinFor(account: Readonly<BoundAccount>): DiscoveryOperation | undefined {
    return this.joins.get(account.accountId)?.get(account.credentialGeneration);
  }

  private removeJoin(account: Readonly<BoundAccount>, operation: DiscoveryOperation): void {
    const accountJoins = this.joins.get(account.accountId);
    if (accountJoins?.get(account.credentialGeneration) !== operation) {
      return;
    }
    accountJoins.delete(account.credentialGeneration);
    if (accountJoins.size === 0) {
      this.joins.delete(account.accountId);
    }
  }
}

async function waitForOperation(
  operation: DiscoveryOperation,
  signal: AbortSignal | undefined,
  onOrphaned: () => void,
): Promise<string> {
  operation.waiters += 1;
  let removeAbortListener = (): void => undefined;
  try {
    throwIfAborted(signal);
    if (signal === undefined) {
      return await operation.completion;
    }
    return await Promise.race([
      operation.completion,
      new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }),
    ]);
  } finally {
    removeAbortListener();
    operation.waiters -= 1;
    if (operation.waiters === 0 && !operation.settled) {
      onOrphaned();
    }
  }
}

async function waitForSource<T>(source: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  let removeAbortListener = (): void => undefined;
  try {
    return await Promise.race([
      source,
      new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => reject(new DOMException("aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }),
    ]);
  } finally {
    removeAbortListener();
  }
}

export function fallbackEndpoint(account: Readonly<BoundAccount>): string {
  if (account.environment.kind === "github.com") {
    return GITHUB_COM_FALLBACK;
  }
  const host = account.environment.host.split(":")[0] ?? account.environment.host;
  return `https://copilot-api.${host}`;
}

export function stripSecretsOnRedirect(fromUrl: string, toUrl: string, headers: Headers): Headers {
  const from = new URL(fromUrl);
  const to = new URL(toUrl);
  const same = from.hostname === to.hostname && effectivePort(from) === effectivePort(to);
  if (same) {
    return headers;
  }
  const next = new Headers(headers);
  for (const name of STRIP_ON_CROSS_HOST) {
    next.delete(name);
  }
  return next;
}

function effectivePort(url: URL): string {
  if (url.port !== "") {
    return url.port;
  }
  return url.protocol === "https:" ? "443" : "80";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new DOMException("aborted", "AbortError");
  }
}

function closedError(): DOMException {
  return new DOMException("closed", "AbortError");
}
