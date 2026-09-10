export type AgentId = "claude" | "codex";
export interface AgentMapping {
  readonly displayName: string;
  readonly modelId: string;
}
export type AgentErrorCode = "agent_conflict" | "agent_recovery_required" | "agent_unsafe_path"
  | "agent_invalid_config" | "agent_models_unavailable" | "agent_busy" | "revision_conflict" | "validation_failed";
export class AgentError extends Error {
  constructor(readonly code: AgentErrorCode) {
    super(code.replaceAll("_", " "));
    this.name = "AgentError";
  }
}
export interface AgentStatus {
  readonly id: AgentId;
  readonly state: "not_managed" | "installed" | "conflict" | "recovery_required" | "unsafe_path";
  readonly revision: string;
  readonly paths: readonly string[];
  readonly endpoint: string;
  readonly backupAvailable: boolean;
  readonly lastAppliedAt: string | null;
  readonly mappings: readonly AgentMapping[];
  readonly canRestore: boolean;
}
export interface AgentsView {
  readonly items: readonly AgentStatus[];
  readonly catalogRevision: string | null;
  readonly modelsAvailable: boolean;
}
export interface AgentApplyRequest {
  readonly agent: AgentId;
  readonly expectedRevision: string;
  readonly catalogRevision: string;
  readonly mappings: readonly AgentMapping[];
}
export interface AgentRestoreRequest {
  readonly agent: AgentId;
  readonly expectedRevision: string;
}
export interface AgentModel {
  readonly modelId: string;
  readonly maxInputTokens: number | null;
}
export interface AgentsManager {
  inspect(origin: string): Promise<readonly AgentStatus[]>;
  apply(request: AgentApplyRequest, origin: string, models: readonly AgentModel[], assertCurrent: () => void, signal: AbortSignal): Promise<AgentStatus>;
  restore(request: AgentRestoreRequest, origin: string, signal: AbortSignal): Promise<AgentStatus>;
  close(): void;
}
export const MAX_MAPPINGS = 16;
export function validateMappings(agent: AgentId, mappings: readonly AgentMapping[]): void {
  if ((agent === "claude" && mappings.length !== 3 && mappings.length !== 4)
    || mappings.length < 1 || mappings.length > MAX_MAPPINGS
    || mappings.some((row) => !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(row.modelId)
      || row.displayName.trim().length === 0 || row.displayName.length > 80 || /[\p{C}]/u.test(row.displayName))
    || (agent === "codex" && new Set(mappings.map((row) => row.modelId)).size !== mappings.length)) {
    throw new AgentError("validation_failed");
  }
}
