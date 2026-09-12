import { writeSync } from "node:fs";
import { DaemonOperationLeaseFile } from "../../src/daemon/operation_lease.js";

const dataDir = process.argv[2];
const crashPhase = process.argv[3];
if (dataDir === undefined || ![
  "database_prepared",
  "database_published",
  "os_locked",
  "released_published",
].includes(crashPhase ?? "")) {
  process.exitCode = 2;
} else {
  const crash = (phase: string): void => {
    if (phase === crashPhase) {
      writeSync(1, `${phase}\n`);
      process.exit(23);
    }
  };
  const lease = await new DaemonOperationLeaseFile({
    onInitializationPhase: crash,
    onPhase: crash,
  }).acquire(dataDir);
  lease.release();
  process.exitCode = 3;
}
