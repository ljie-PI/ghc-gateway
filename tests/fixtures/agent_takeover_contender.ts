import fs, { writeSync } from "node:fs";
import path from "node:path";
import { FileAgentsManager } from "../../src/agents/manager.js";
import { AgentError, type AgentModel } from "../../src/agents/types.js";

const home = process.argv[2];
const origin = process.argv[3];
const modelId = process.argv[4];
const concurrent = process.argv[5] === "--concurrent";
const synchronizationDirectory = process.argv[6];
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
  let synchronized = false;
  try {
    const status = (await manager.inspect(origin)).find((item) => item.id === "codex")!;
    if (status.state === "unsafe_path") throw new AgentError("agent_unsafe_path");
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
        if (synchronizationDirectory !== undefined && !synchronized) {
          fs.writeFileSync(path.join(synchronizationDirectory, "link-state"), "");
          const deadline = Date.now() + 10_000;
          while (!fs.existsSync(path.join(synchronizationDirectory, "state-linked"))) {
            if (Date.now() >= deadline) throw new Error("Timed out waiting for linked state database");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          synchronized = true;
        }
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
            && (error.code === "agent_busy" || error.code === "revision_conflict"
              || (concurrent && synchronized && error.code === "agent_unsafe_path")))) throw error;
        } finally {
          if (synchronized) {
            fs.writeFileSync(path.join(synchronizationDirectory!, "release-owner"), "");
            const deadline = Date.now() + 10_000;
            while (!fs.existsSync(path.join(synchronizationDirectory!, "owner-complete"))) {
              if (Date.now() >= deadline) throw new Error("Timed out waiting for takeover owner");
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
        }
      }
      if (status.state === "unsafe_path") throw new AgentError("agent_unsafe_path");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!settled) {
      const status = (await manager.inspect(origin)).find((item) => item.id === "codex")!;
      if (status.state === "unsafe_path") throw new AgentError("agent_unsafe_path");
      if (status.state !== "installed") throw new Error(`Codex contender did not settle: ${status.state}`);
    }
  }
  manager.close();
  writeSync(1, `${result}\n`);
}
