import path from "node:path";
import { CliError } from "../cli/control_client.js";
import { DaemonIdentityFileError } from "./identity_file.js";
import type { DaemonOperationLeaseAccess, DaemonOperationLeaseHandle } from "./operation_lease.js";

export interface LifecycleOperationContext {
  readonly signal?: AbortSignal;
}

export interface LifecycleCoordinatorAccess {
  run<T>(
    dataDir: string,
    context: Readonly<LifecycleOperationContext>,
    operation: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T>;
}

interface QueueNode {
  readonly signal: AbortSignal | undefined;
  readonly operation: (signal: AbortSignal | undefined) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  started: boolean;
  settled: boolean;
  removeAbortListener(): void;
}

interface DirectoryLane {
  readonly key: string;
  readonly queue: QueueNode[];
  draining: boolean;
}

export class LifecycleCoordinator implements LifecycleCoordinatorAccess {
  private readonly lanes = new Map<string, DirectoryLane>();

  constructor(private readonly leases: Readonly<DaemonOperationLeaseAccess>) {}

  async run<T>(
    dataDir: string,
    context: Readonly<LifecycleOperationContext>,
    operation: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    const signal = context.signal;
    if (signal?.aborted === true) throw new CliError("interrupted");
    const key = path.resolve(dataDir);
    const lane = this.lanes.get(key) ?? { key, queue: [], draining: false };
    this.lanes.set(key, lane);

    return await new Promise<T>((resolve, reject) => {
      const node: QueueNode = {
        signal,
        operation,
        resolve: (value) => resolve(value as T),
        reject,
        started: false,
        settled: false,
        removeAbortListener: () => undefined,
      };
      const abort = (): void => {
        if (node.started || node.settled) return;
        node.settled = true;
        node.removeAbortListener();
        const index = lane.queue.indexOf(node);
        if (index >= 0) lane.queue.splice(index, 1);
        reject(new CliError("interrupted"));
      };
      if (signal !== undefined) {
        signal.addEventListener("abort", abort, { once: true });
        node.removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      lane.queue.push(node);
      if (!lane.draining) void this.drain(lane);
    });
  }

  private async drain(lane: DirectoryLane): Promise<void> {
    lane.draining = true;
    try {
      for (;;) {
        const node = lane.queue.shift();
        if (node === undefined) return;
        if (node.settled) continue;
        node.started = true;
        node.removeAbortListener();
        let lease: DaemonOperationLeaseHandle | undefined;
        try {
          if (node.signal?.aborted === true) throw new CliError("interrupted");
          lease = await this.leases.acquire(lane.key, {
            ...(node.signal === undefined ? {} : { signal: node.signal }),
          });
          if (signalIsAborted(node.signal)) throw new CliError("interrupted");
          const result = await node.operation(node.signal);
          if (signalIsAborted(node.signal)) throw new CliError("interrupted");
          lease.release();
          lease = undefined;
          node.resolve(result);
        } catch (error: unknown) {
          try {
            lease?.release();
          } catch (releaseError: unknown) {
            node.reject(normalizeCoordinatorError(releaseError, node.signal));
            node.settled = true;
            continue;
          }
          node.reject(normalizeCoordinatorError(error, node.signal));
        } finally {
          node.settled = true;
        }
      }
    } finally {
      lane.draining = false;
      if (lane.queue.length === 0 && this.lanes.get(lane.key) === lane) {
        this.lanes.delete(lane.key);
      } else if (lane.queue.length > 0) {
        void this.drain(lane);
      }
    }
  }
}

export const sharedInProcessLifecycleCoordinator: LifecycleCoordinatorAccess = new LifecycleCoordinator({
  acquire: async () => ({ release() {} }),
});

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function normalizeCoordinatorError(error: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted === true) return new CliError("interrupted");
  if (error instanceof CliError) return error;
  if (error instanceof DaemonIdentityFileError) {
    const cause = error.cause;
    if (isPermissionError(cause)) return new CliError("permission_denied");
    return new CliError("security_error");
  }
  if (isPermissionError(error)) return new CliError("permission_denied");
  return error;
}

function isPermissionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "EACCES" || error.code === "EPERM");
}
