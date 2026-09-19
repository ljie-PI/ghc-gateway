import path from "node:path";
import { queryWindowsSecuritySnapshot, type WindowsSecuritySnapshotFact, type WindowsSecuritySnapshotRequest } from "../security/windows_security_snapshot.js";
import { AgentError } from "./types.js";
import { observeSecurityPath, type SecurityPathSnapshot } from "./files.js";

export type WindowsSecurityQuery = (
  requests: readonly WindowsSecuritySnapshotRequest[],
) => Promise<readonly WindowsSecuritySnapshotFact[]>;

export class AgentWindowsSecurity {
  private sequence = 0;

  constructor(private readonly query: WindowsSecurityQuery = queryWindowsSecuritySnapshot) {}

  async snapshot(paths: readonly string[], pathOnly: readonly string[] = []): Promise<ReadonlyMap<string, SecurityPathSnapshot>> {
    const snapshot = ++this.sequence;
    const requests: WindowsSecuritySnapshotRequest[] = [];
    const observations = new Map<string, ReturnType<typeof observeSecurityPath>>();
    const pathOnlyKeys = new Set(pathOnly.map((target) => path.win32.normalize(target).toLowerCase()));
    for (const candidate of paths) {
      const normalized = path.win32.normalize(candidate).toLowerCase();
      if (observations.has(normalized)) continue;
      observations.set(normalized, observeSecurityPath(normalized));
      requests.push(pathOnlyKeys.has(normalized)
        ? { id: `snapshot-${snapshot}-path-${requests.length}`, path: normalized, security: false }
        : { id: `snapshot-${snapshot}-path-${requests.length}`, path: normalized });
    }
    let facts: readonly WindowsSecuritySnapshotFact[];
    try {
      facts = await this.query(requests);
      if (facts.length !== requests.length || facts.some((fact, index) => fact?.id !== requests[index]?.id)) throw new Error();
    } catch {
      throw new AgentError("agent_unsafe_path");
    }
    return new Map(requests.map((request, index) => {
      const observation = observations.get(request.path);
      const fact = facts[index];
      if (observation === undefined || fact === undefined) throw new AgentError("agent_unsafe_path");
      return [request.path, { observation, fact }];
    }));
  }

  require(snapshots: ReadonlyMap<string, SecurityPathSnapshot>, target: string): SecurityPathSnapshot {
    const snapshot = snapshots.get(path.win32.normalize(target).toLowerCase());
    if (snapshot === undefined) throw new AgentError("agent_unsafe_path");
    return snapshot;
  }

}
