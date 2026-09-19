import path from "node:path";
import { queryWindowsSecuritySnapshot, type WindowsSecuritySnapshotFact, type WindowsSecuritySnapshotRequest } from "../security/windows_security_snapshot.js";
import { AgentError } from "./types.js";
import { observeSecurityPath, sameSecurityPathIdentity, sameSecurityPathObservation, type SecurityPathSnapshot } from "./files.js";

export type WindowsSecurityQuery = (
  requests: readonly WindowsSecuritySnapshotRequest[],
) => Promise<readonly WindowsSecuritySnapshotFact[]>;

export class AgentWindowsSecurity {
  private sequence = 0;

  constructor(private readonly query: WindowsSecurityQuery = queryWindowsSecuritySnapshot) {}

  async snapshot(
    paths: readonly string[],
    pathOnly: readonly string[] = [],
    kind: "snapshot" | "private" = "snapshot",
  ): Promise<ReadonlyMap<string, SecurityPathSnapshot>> {
    const snapshot = ++this.sequence;
    const requests: WindowsSecuritySnapshotRequest[] = [];
    const observations = new Map<string, ReturnType<typeof observeSecurityPath>>();
    const pathOnlyKeys = new Set(pathOnly.map((target) => path.win32.normalize(target).toLowerCase()));
    for (const candidate of paths) {
      const normalized = path.win32.normalize(candidate).toLowerCase();
      if (observations.has(normalized)) continue;
      observations.set(normalized, observeSecurityPath(normalized));
      requests.push(pathOnlyKeys.has(normalized)
        ? { id: `${kind}-${snapshot}-path-${requests.length}`, path: normalized, security: false }
        : { id: `${kind}-${snapshot}-path-${requests.length}`, path: normalized });
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

  async privateSnapshot(target: string, directory: boolean, validate: () => Promise<void>): Promise<SecurityPathSnapshot> {
    const before = this.require(await this.snapshot([target], [], "private"), target);
    await validate();
    const after = this.require(await this.snapshot([target], [], "private"), target);
    if (!samePrivateSnapshot(before, after, directory)) throw new AgentError("agent_unsafe_path");
    return after;
  }

  samePrivate(left: SecurityPathSnapshot, right: SecurityPathSnapshot, directory: boolean): boolean {
    return samePrivateSnapshot(left, right, directory);
  }
}

function samePrivateSnapshot(left: SecurityPathSnapshot, right: SecurityPathSnapshot, directory: boolean): boolean {
  return (directory ? sameSecurityPathIdentity(left.observation, right.observation)
    : sameSecurityPathObservation(left.observation, right.observation))
    && left.fact.status === "present" && right.fact.status === "present"
    && !left.fact.reparse && !right.fact.reparse
    && left.fact.owner === right.fact.owner && left.fact.sddl === right.fact.sddl;
}
