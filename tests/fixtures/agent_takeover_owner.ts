import fs from "node:fs";
import path from "node:path";
import { FileAgentsManager } from "../../src/agents/manager.js";
import type { AgentModel } from "../../src/agents/types.js";

const home = process.argv[2];
const origin = process.argv[3];
const modelId = process.argv[4];
const synchronizationDirectory = process.argv[6];
const persistentLink = process.argv[7] === "--persistent-link";
if (home === undefined || origin === undefined || modelId === undefined || synchronizationDirectory === undefined) {
  process.exitCode = 2;
} else {
  const marker = (name: string) => path.join(synchronizationDirectory, name);
  const waitFor = (name: string) => {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(marker(name))) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${name}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  };
  const manager = new FileAgentsManager({
    home,
    checkpoint: (point, agent) => {
      if (point !== "intent" || agent !== "codex") return;
      fs.writeFileSync(marker("owner-ready"), "");
      waitFor("link-state");
      const state = path.join(home, ".ghc-gateway", "agents", "codex", "state.db");
      const alias = marker("state-alias.db");
      fs.linkSync(state, alias);
      fs.writeFileSync(marker("state-linked"), "");
      try {
        waitFor("release-owner");
      } finally {
        if (!persistentLink) fs.rmSync(alias, { force: true });
      }
    },
  });
  const model: AgentModel = {
    modelId,
    protocols: { value: ["responses"], source: "live", conflict: false, liveState: "value" },
    capabilities: {
      contextWindowTokens: 32_000, maxContextWindowTokens: 32_000,
      reasoningLevels: [], reasoningProtocols: [], inputModalities: ["text"],
      toolCalling: false, parallelToolCalling: false, reasoningSummaries: false, verbosity: false, search: false,
    },
  };
  const status = (await manager.inspect(origin)).find((item) => item.id === "codex")!;
  if (status.takeover === null) throw new Error("Codex takeover is unavailable");
  try {
    await manager.takeover({
      agent: "codex", expectedRevision: status.revision, catalogRevision: "a".repeat(64),
      takeoverRevision: status.takeover.revision, mappings: [{ modelId, displayName: modelId }],
    }, origin, [model], () => undefined, new AbortController().signal);
  } finally {
    fs.writeFileSync(marker("owner-complete"), "");
  }
  manager.close();
  fs.writeSync(1, "installed\n");
}
