import { appendFileSync, writeSync } from "node:fs";
import { access } from "node:fs/promises";
import { DaemonOperationLeaseFile } from "../../src/daemon/operation_lease.js";

const dataDir = process.argv[2];
const gatePath = process.argv[3];
const eventsPath = process.argv[4];
const contender = process.argv[5];
if (dataDir === undefined || gatePath === undefined || eventsPath === undefined || contender === undefined) {
  process.exitCode = 2;
} else {
  const processStartIdentity = identityForPid(process.pid);
  const lease = await new DaemonOperationLeaseFile({
    processStartIdentity: async () => processStartIdentity,
    processIdentity: async (pid) => identityForPid(pid),
    onInitializationPhase: async (phase) => {
      if (phase !== "database_prepared") return;
      writeSync(1, "ready\n");
      await waitFor(gatePath);
    },
  }).acquire(dataDir);
  try {
    appendFileSync(eventsPath, `start:${contender}\n`, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 150));
    appendFileSync(eventsPath, `end:${contender}\n`, "utf8");
  } finally {
    lease.release();
  }
  writeSync(1, "done\n");
}

function identityForPid(pid: number): string {
  if (process.platform === "win32") return `windows:${String(pid)}`;
  if (process.platform === "darwin") {
    return `macos:${new Date(Date.UTC(2026, 0, 1, 0, 0, pid)).toISOString().replace(".000Z", "Z")}`;
  }
  return `linux:01234567-89ab-cdef-0123-456789abcdef:${String(pid)}`;
}

async function waitFor(filePath: string): Promise<void> {
  for (;;) {
    try {
      await access(filePath);
      return;
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
