import { writeSync } from "node:fs";
import { FileAgentsManager } from "../../src/agents/manager.js";
import type { AgentModel } from "../../src/agents/types.js";

const home = process.argv[2];
const origin = process.argv[3];
const modelId = process.argv[4];
if (home === undefined || origin === undefined || modelId === undefined) process.exitCode = 2;
else {
  const manager = new FileAgentsManager({ home });
  const model: AgentModel = {
    modelId,
    protocols: { value: ["responses"], source: "live", conflict: false, liveState: "value" },
    capabilities: {
      contextWindowTokens: 32_000, maxContextWindowTokens: 32_000,
      reasoningLevels: [], reasoningProtocols: [], inputModalities: ["text"],
      toolCalling: false, parallelToolCalling: false, reasoningSummaries: false, verbosity: false, search: false,
    },
  };
  let result = "busy";
  try {
    const status = (await manager.inspect(origin)).find((item) => item.id === "codex")!;
    if (status.takeover !== null) {
      await manager.takeover({
        agent: "codex", expectedRevision: status.revision, catalogRevision: "a".repeat(64),
        takeoverRevision: status.takeover.revision, mappings: [{ modelId, displayName: modelId }],
      }, origin, [model], () => undefined, new AbortController().signal);
      result = "installed";
    }
  } catch (error: unknown) {
    if (!(typeof error === "object" && error !== null && "code" in error
      && (error.code === "agent_busy" || error.code === "revision_conflict" || error.code === "agent_conflict"))) throw error;
  }
  if (result === "busy") {
    let settled = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = (await manager.inspect(origin)).find((item) => item.id === "codex")!;
      if (status.state === "installed") { settled = true; break; }
      if (status.state === "recovery_required") {
        try {
          await manager.apply({
            agent: "codex", expectedRevision: status.revision, catalogRevision: "a".repeat(64),
            mappings: [{ modelId, displayName: modelId }],
          }, origin, [model], () => undefined, new AbortController().signal);
          result = "installed";
          settled = true;
          break;
        } catch (error: unknown) {
          if (!(typeof error === "object" && error !== null && "code" in error
            && (error.code === "agent_busy" || error.code === "revision_conflict"))) throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!settled) {
      const status = (await manager.inspect(origin)).find((item) => item.id === "codex")!;
      if (status.state !== "installed") throw new Error(`Codex contender did not settle: ${status.state}`);
    }
  }
  manager.close();
  writeSync(1, `${result}\n`);
}
