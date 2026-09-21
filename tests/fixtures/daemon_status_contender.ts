import { authenticatedControlRequest } from "../../src/cli/control_client.js";
import { runCli } from "../../src/cli/main.js";
import { DaemonController } from "../../src/daemon/controller.js";
import { DaemonIdentityFile } from "../../src/daemon/identity_file.js";
import { LifecycleCoordinator } from "../../src/daemon/lifecycle_coordinator.js";
import { DaemonOperationLeaseFile } from "../../src/daemon/operation_lease.js";
import { deterministicProcessIdentity, identityForPid } from "../support/deterministic_process_identity.js";

const processIdentity = async (pid: number): Promise<string | null> => deterministicProcessIdentity(pid);
const lifecycleCoordinator = new LifecycleCoordinator(new DaemonOperationLeaseFile({
  processStartIdentity: async () => identityForPid(process.pid),
  processIdentity,
}));
const controller = new DaemonController({
  lifecycleCoordinator,
  identityFile: {
    read: async (dataDir, context) => {
      context.signal.throwIfAborted();
      const identity = new DaemonIdentityFile(dataDir, { processIdentity }).read();
      context.signal.throwIfAborted();
      return identity;
    },
    remove: async (dataDir, expected, context) => await new DaemonIdentityFile(
      dataDir,
      { processIdentity },
    ).remove(expected, context),
  },
  processIdentity: async (pid) => await processIdentity(pid),
  spawn: async () => { throw new Error("status fixture must not spawn a daemon"); },
  delay: async (ms, signal) => await delay(ms, signal),
  nowMs: Date.now,
  controlRequest: async (identity, method, requestPath, context = {}) => await authenticatedControlRequest(
    identity,
    method,
    requestPath,
    undefined,
    context,
  ),
  terminate: async () => { throw new Error("status fixture must not terminate a daemon"); },
});

process.exitCode = await runCli({
  argv: process.argv.slice(2),
  daemonController: controller,
});

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
