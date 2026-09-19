import { writeSync } from "node:fs";
import path from "node:path";
import { AgentStore } from "../../src/agents/store.js";

const home = process.argv[2];
const dataDir = process.argv[3];
if (home === undefined || dataDir === undefined) {
  process.exitCode = 2;
} else {
  const store = new AgentStore(path.join(dataDir, "agents"), "codex", path.join(home, ".ghc-gateway-agents"));
  let revision: number | undefined;
  for (let attempt = 0; attempt < 20 && revision === undefined; attempt += 1) {
    try {
      revision = (await store.read()).revision;
    } catch (error: unknown) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "agent_busy")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (revision === undefined) process.exitCode = 3;
  else writeSync(1, `${revision}\n`);
}
