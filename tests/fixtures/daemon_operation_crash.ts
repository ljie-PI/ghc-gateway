import { writeSync } from "node:fs";
import { DaemonOperationLeaseFile } from "../../src/daemon/operation_lease.js";

const dataDir = process.argv[2];
const crashPhase = process.argv[3];
if (dataDir === undefined || (crashPhase !== "os_locked" && crashPhase !== "released_published")) {
  process.exitCode = 2;
} else {
  const lease = await new DaemonOperationLeaseFile({
    onPhase: (phase) => {
      if (phase === crashPhase) {
        writeSync(1, `${phase}\n`);
        process.exit(23);
      }
    },
  }).acquire(dataDir);
  lease.release();
  process.exitCode = 3;
}
