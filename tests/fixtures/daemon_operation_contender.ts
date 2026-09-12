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
  writeSync(1, "ready\n");
  while (!await exists(gatePath)) await new Promise((resolve) => setTimeout(resolve, 10));
  const lease = await new DaemonOperationLeaseFile().acquire(dataDir);
  appendFileSync(eventsPath, `start:${contender}\n`, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 150));
  appendFileSync(eventsPath, `end:${contender}\n`, "utf8");
  lease.release();
  writeSync(1, "done\n");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
