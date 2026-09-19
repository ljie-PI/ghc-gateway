import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { AgentError, validateMappings, type AgentId, type AgentStatus, type AgentsManager, type AgentApplyRequest, type AgentTakeoverRequest, type AgentModel } from "./types.js";
import { AgentStore, copyMappings, newImage, type AgentState, type StepState } from "./store.js";
import { applyAccess, assertNoLinks, assertOwned, assertOwnedFromSecuritySnapshot, assertPrivate, assertSecurityPathUnchanged, canonical, digest, exists, observeSecurityPath, privateDirectory, protect, readImage, readImageFromSecuritySnapshot, sameDisplacedContent, sameImage, sameSecurityPathIdentity, sameSecurityPathObservation, syncDirectory, writeExclusive, type FileImage, type SecurityPathAllowedLink, type SecurityPathObservation, type SecurityPathSnapshot } from "./files.js";
import { projectAgent, validateCodexTakeover } from "./transform.js";
import {
  type WindowsSecuritySnapshotFact,
  type WindowsSecuritySnapshotRequest,
} from "../security/windows_security_snapshot.js";
import { AgentWindowsSecurity } from "./windows_security.js";

type PreparedInspection =
  | { readonly agent: AgentId; readonly state: AgentState; readonly paths: readonly string[]; readonly privateObservations: ReadonlyMap<number, SecurityPathObservation>; readonly pendingLinks: ReadonlyMap<number, PendingLinkObservation>; readonly takeoverPaths?: readonly string[]; readonly takeoverPrivateObservations?: ReadonlyMap<number, SecurityPathObservation>; readonly error?: unknown }
  | { readonly agent: AgentId; readonly error: unknown };
interface PendingLinkObservation {
  readonly step: StepState;
  readonly scratch: SecurityPathObservation;
}
interface TakeoverEvidence extends NonNullable<AgentStatus["takeover"]> {
  readonly images: readonly (FileImage | null)[];
  readonly paths: readonly string[];
}
type ConsumedInspection =
  | { readonly agent: AgentId; readonly state: AgentState; readonly paths: readonly string[]; readonly images: readonly (FileImage | null)[]; readonly takeoverPaths?: readonly string[]; readonly takeoverImages?: readonly (FileImage | null)[]; readonly error?: unknown }
  | { readonly agent: AgentId; readonly error: unknown };

export interface AgentManagerOptions {
  readonly home?: string;
  readonly dataDir?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly now?: () => Date;
  readonly queryWindowsSecuritySnapshot?: (
    requests: readonly WindowsSecuritySnapshotRequest[],
  ) => Promise<readonly WindowsSecuritySnapshotFact[]>;
  /** Deterministic failure/race injection at durable transaction boundaries. */
  readonly checkpoint?: (point: "before_intent" | "intent" | "stage_written" | "staged" | "displaced" | "linked" | "published" | "complete", agent: AgentId, index: number) => void;
}

export class FileAgentsManager implements AgentsManager {
  private readonly home: string;
  private readonly root: string;
  private readonly legacyRoot: string;
  private readonly paths: Record<AgentId, readonly string[]>;
  private readonly busy = new Set<AgentId>();
  private readonly windowsSecurity: AgentWindowsSecurity;
  private closed = false;

  constructor(private readonly options: AgentManagerOptions = {}) {
    this.windowsSecurity = new AgentWindowsSecurity(options.queryWindowsSecuritySnapshot);
    // Resolve the existing home anchor once. macOS exposes its temporary home
    // paths through the system /var -> /private/var alias; canonicalizing that
    // trusted anchor avoids rejecting the OS alias while links below it remain
    // forbidden. A durable baseline pins its own target paths.
    this.home = fs.realpathSync.native(path.resolve(options.home ?? os.homedir()));
    const dataDir = path.resolve(options.dataDir ?? path.join(this.home, ".ghc-gateway"));
    this.root = path.join(dataDir, "agents");
    this.legacyRoot = path.join(this.home, ".ghc-gateway-agents");
    const env = options.env ?? {};
    const claude = path.resolve(env.CLAUDE_CONFIG_DIR ?? path.join(this.home, ".claude"));
    const codex = path.resolve(env.CODEX_HOME ?? path.join(this.home, ".codex"));
    this.paths = {
      claude: [path.join(claude, "settings.json")],
      codex: [path.join(codex, "models.json"), path.join(codex, "config.toml")],
    };
  }

  async inspect(origin: string): Promise<readonly AgentStatus[]> {
    const agents = ["claude", "codex"] as const;
    if (process.platform !== "win32") return await Promise.all(agents.map((agent) => this.status(agent, origin)));
    let prepared = await Promise.all(agents.map(async (agent): Promise<PreparedInspection> => {
      try {
        const state = await this.store(agent).read();
        const paths = this.fallbackTargetPaths(agent, state);
        const privateObservations = await this.privateTargetObservations(state, paths);
        const pendingLinks = await this.pendingLinkObservations(state.pending?.steps ?? []);
        const takeoverPaths = agent === "codex" && state.pending === null ? this.takeoverPaths(state) : undefined;
        const takeoverPrivateObservations = takeoverPaths === undefined
          ? undefined : await this.takeoverPrivateObservations(takeoverPaths);
        return takeoverPaths === undefined || takeoverPrivateObservations === undefined
          ? { agent, state, paths, privateObservations, pendingLinks }
          : { agent, state, paths, privateObservations, pendingLinks, takeoverPaths, takeoverPrivateObservations };
      } catch (error: unknown) {
        return { agent, error };
      }
    }));
    const candidates: string[] = [];
    const parents: string[] = [];
    prepared = prepared.map((item): PreparedInspection => {
      if (!("paths" in item)) return item;
      try {
        for (const target of item.paths) {
          const parent = this.existingParent(target);
          candidates.push(parent, target);
          parents.push(parent);
        }
        for (const { step } of item.pendingLinks.values()) {
          candidates.push(step.scratch, path.join(step.scratch, "next"));
          parents.push(step.scratch);
        }
        for (const target of item.takeoverPaths ?? []) {
          const parent = this.existingParent(target);
          candidates.push(parent, target);
          parents.push(parent);
        }
        return item;
      } catch (error: unknown) {
        return { ...item, error };
      }
    });
    if (candidates.length === 0) {
      return await Promise.all(prepared.map((item) => this.status(item.agent, origin, "paths" in item
        ? { state: item.state, paths: item.paths, error: item.error }
        : { error: item.error })));
    }
    let snapshots: ReadonlyMap<string, SecurityPathSnapshot>;
    try {
      snapshots = await this.windowsSecuritySnapshots(candidates, parents);
    } catch (_error: unknown) {
      const failure = new AgentError("agent_unsafe_path");
      return await Promise.all(prepared.map((item) => "paths" in item
        ? this.status(item.agent, origin, { state: item.state, paths: item.paths, error: item.error ?? failure })
        : this.status(item.agent, origin, { error: item.error })));
    }
    const consumed = this.consumeWindowsInspection(prepared, snapshots);
    return await Promise.all(consumed.map((item) => "paths" in item
      ? this.status(item.agent, origin, item)
      : this.status(item.agent, origin, { error: item.error })));
  }

  async apply(request: AgentApplyRequest, origin: string, models: readonly AgentModel[], assertCurrent: () => void, signal: AbortSignal): Promise<AgentStatus> {
    return await this.mutate(request, origin, models, assertCurrent, signal, false);
  }

  async takeover(request: AgentTakeoverRequest, origin: string, models: readonly AgentModel[], assertCurrent: () => void, signal: AbortSignal): Promise<AgentStatus> {
    if (request.agent !== "codex") throw new AgentError("validation_failed");
    return await this.mutate(request, origin, models, assertCurrent, signal, true);
  }

  private async mutate(
    request: AgentApplyRequest | AgentTakeoverRequest,
    origin: string,
    models: readonly AgentModel[],
    assertCurrent: () => void,
    signal: AbortSignal,
    takeover: boolean,
  ): Promise<AgentStatus> {
    return await this.exclusive(request.agent, async () => {
      signal.throwIfAborted();
      validateMappings(request.agent, request.mappings);
      const store = this.store(request.agent);
      // Parse and validate BEFORE making a recovery directory or lock file.
      const initial = await store.read();
      const paths = this.targetPaths(request.agent, initial);
      const before = await this.images(paths, initial);
      this.requireRevision(request.expectedRevision, initial, before, paths, origin);
      if (takeover) await this.requireTakeoverRevision(request as AgentTakeoverRequest, initial, origin);
      if (initial.pending === null) this.project(request, initial, before, paths, origin, models, takeover);
      signal.throwIfAborted();
      assertCurrent();
      return await store.locked(async (save) => {
        const state = await store.read();
        let current = await this.images(paths, state);
        this.requireRevision(request.expectedRevision, state, current, paths, origin);
        const takeoverEvidence = takeover
          ? await this.requireTakeoverRevision(request as AgentTakeoverRequest, state, origin)
          : undefined;
        assertCurrent();
        signal.throwIfAborted();
        const recovering = state.pending !== null;
        if (recovering) {
          // Resume only the already-durable transaction, never a new restore.
          current = [...await this.requireRecoverable(state, current)];
          await this.execute(request.agent, state, save);
          await this.finish(request.agent, state, save);
        }
        const livePaths = this.targetPaths(request.agent, state);
        if (process.platform !== "win32" || recovering || !samePaths(paths, livePaths)) {
          current = await this.images(livePaths, state);
        }
        if (initial.pending === null) this.requireRevision(request.expectedRevision, state, current, livePaths, origin);
        const projection = this.project(request, state, current, livePaths, origin, models, takeover);
        const prepared = await this.prepareTargets(
          request.agent, state, current, livePaths, takeover, takeoverEvidence,
        );
        current = prepared.current;
        const after = request.agent === "claude"
          ? [prepared.backup, newImage(projection.config, current[1]!)]
          : [prepared.configBackup, prepared.catalogBackup, newImage(projection.catalog!, current[2]!), newImage(projection.config, current[3]!)];
        const steps = this.plan(request.agent, state, current, after);
        for (const [index, target] of state.targets.entries()) target.expected = current[index]!;
        state.mappings = copyMappings(request.mappings);
        if (steps.length === 0) {
          state.lastAppliedAt = (this.options.now ?? (() => new Date()))().toISOString();
          state.revision += 1;
          await save(state, () => this.requireCurrent(request.agent, assertCurrent, signal));
          return await this.status(request.agent, origin);
        }
        state.pending = { kind: "apply", steps, garbage: [] };
        // From this durable intent onward cancellation must not interrupt commit.
        await save(state, () => this.requireCurrent(request.agent, assertCurrent, signal));
        this.hit("intent", request.agent, -1);
        await this.execute(request.agent, state, save);
        state.lastAppliedAt = (this.options.now ?? (() => new Date()))().toISOString();
        await this.finish(request.agent, state, save);
        return await this.status(request.agent, origin);
      });
    });
  }

  private project(request: AgentApplyRequest, state: AgentState, images: readonly (FileImage | null)[], paths: readonly string[], origin: string, models: readonly AgentModel[], takeover = false) {
    const config = images.at(-1) ?? null;
    const managedConfig = state.targets.at(-1)?.expected ?? null;
    const catalogPath = path.join(path.dirname(paths.at(-1)!), "models.json");
    return projectAgent(
      request.agent,
      config === null ? null : Buffer.from(config.bytes, "base64"),
      request.mappings,
      origin,
      catalogPath,
      models,
      managedConfig === null ? null : Buffer.from(managedConfig.bytes, "base64"),
      takeover,
    );
  }

  private async prepareTargets(
    agent: AgentId,
    state: AgentState,
    current: (FileImage | null)[],
    paths: readonly string[],
    takeover: boolean,
    takeoverEvidence?: TakeoverEvidence,
  ) {
    if ((agent === "claude" && state.version >= 2 || agent === "codex" && state.version === 3) && state.targets.length > 0) {
      this.requireBackup(state, current);
      if (agent === "codex" && takeoverEvidence !== undefined) {
        const targetPaths = state.targets.map((target) => target.path);
        const fresh = await this.images(targetPaths, state);
        if (!sameFilePaths(takeoverEvidence.paths, targetPaths)
          || fresh.some((image, index) => !sameImage(image, takeoverEvidence.images[index]!))) {
          throw new AgentError("revision_conflict");
        }
        current = fresh;
      }
      return agent === "claude"
        ? { current, backup: state.targets[0]!.expected, configBackup: null, catalogBackup: null }
        : { current, backup: null, configBackup: state.targets[0]!.expected, catalogBackup: state.targets[1]!.expected };
    }
    const configPath = paths.at(-1)!;
    const backupPath = `${configPath}.ghcg.bak`;
    const clientPaths = agent === "claude" ? [configPath] : [path.join(path.dirname(configPath), "models.json"), configPath];
    const catalogBackupPath = agent === "codex" ? `${clientPaths[0]}.ghcg.bak` : undefined;
    let existing: FileImage | null;
    let existingCatalogBackup: FileImage | null = null;
    let clientImages: (FileImage | null)[];
    if (process.platform === "win32") {
      const privateObservation = exists(backupPath) ? await this.privateObservation(backupPath, false) : observeSecurityPath(backupPath);
      const catalogBackupObservation = catalogBackupPath === undefined ? undefined
        : exists(catalogBackupPath) ? await this.privateObservation(catalogBackupPath, false) : observeSecurityPath(catalogBackupPath);
      const preparedPaths = [...new Set([backupPath, ...(catalogBackupPath === undefined ? [] : [catalogBackupPath]), ...paths, ...clientPaths])];
      const prepared: (FileImage | null)[] = [];
      const snapshots = await this.windowsImages(preparedPaths, undefined, prepared);
      const preparedByPath = new Map(preparedPaths.map((target, index) => [target, prepared[index]!]));
      existing = preparedByPath.get(backupPath)!;
      const backupSnapshot = this.requireWindowsSnapshot(snapshots, backupPath);
      if (!sameSecurityPathObservation(privateObservation, backupSnapshot.observation)) throw new AgentError("agent_unsafe_path");
      if (catalogBackupPath !== undefined && catalogBackupObservation !== undefined) {
        existingCatalogBackup = preparedByPath.get(catalogBackupPath)!;
        if (!sameSecurityPathObservation(catalogBackupObservation,
          this.requireWindowsSnapshot(snapshots, catalogBackupPath).observation)) throw new AgentError("agent_unsafe_path");
      }
      clientImages = clientPaths.map((target) => preparedByPath.get(target)!);
    } else {
      existing = await readImage(backupPath);
      if (existing !== null) await assertPrivate(backupPath, false);
      if (catalogBackupPath !== undefined) {
        existingCatalogBackup = await readImage(catalogBackupPath);
        if (existingCatalogBackup !== null) await assertPrivate(catalogBackupPath, false);
      }
      clientImages = await this.images(clientPaths);
    }
    const original = state.targets.length === 0 ? current.at(-1)! : state.targets.at(-1)!.original;
    if (existing !== null && existing.bytes !== original?.bytes) throw new AgentError("agent_conflict");
    if (!sameImage(clientImages.at(-1)!, current.at(-1)!)) throw new AgentError("agent_conflict");
    if (agent === "codex") {
      if (takeoverEvidence !== undefined) {
        const observed = [existing, existingCatalogBackup, ...clientImages];
        if (!sameFilePaths(takeoverEvidence.paths, [backupPath, catalogBackupPath!, ...clientPaths])
          || observed.some((image, index) => !sameImage(image, takeoverEvidence.images[index]!))) {
          throw new AgentError("revision_conflict");
        }
      }
      if (clientImages[0] !== null && !takeover) throw new AgentError("agent_conflict");
      if (existingCatalogBackup !== null) throw new AgentError("agent_conflict");
      state.targets = [
        { path: backupPath, original: existing, expected: existing },
        { path: catalogBackupPath!, original: null, expected: null },
        { path: clientPaths[0]!, original: clientImages[0]!, expected: clientImages[0]! },
        { path: clientPaths[1]!, original, expected: clientImages[1]! },
      ];
      state.version = 3;
      return {
        current: [existing, existingCatalogBackup, ...clientImages],
        backup: null,
        configBackup: existing ?? (original === null ? null : newImage(Buffer.from(original.bytes, "base64"), null)),
        catalogBackup: clientImages[0] === null ? null : newImage(Buffer.from(clientImages[0]!.bytes, "base64"), null),
      };
    }
    const oldTargets = state.targets;
    state.targets = [
      { path: backupPath, original: existing, expected: existing },
      ...clientPaths.map((target, index) => ({
        path: target,
        original: index === clientPaths.length - 1 ? original : oldTargets.find((item) => item.path === target)?.original ?? clientImages[index]!,
        expected: clientImages[index]!,
      })),
    ];
    state.version = 2;
    return {
      current: [existing, ...clientImages],
      backup: existing ?? (original === null ? null : newImage(Buffer.from(original.bytes, "base64"), null)),
      configBackup: null,
      catalogBackup: null,
    };
  }

  private requireBackup(state: AgentState, images: readonly (FileImage | null)[]): void {
    if (state.version === 1 || state.targets.length === 0) return;
    if (!sameImage(state.targets[0]!.expected, images[0]!)) throw new AgentError("agent_conflict");
    if (state.version === 3 && state.targets.length === 4) {
      if (!sameImage(state.targets[1]!.expected, images[1]!)) throw new AgentError("agent_conflict");
    }
  }

  private async requireTakeoverRevision(
    request: AgentTakeoverRequest,
    state: AgentState,
    origin: string,
  ): Promise<TakeoverEvidence> {
    const evidence = await this.takeoverEvidence(state, origin);
    if (request.takeoverRevision !== evidence.revision) {
      throw new AgentError("revision_conflict");
    }
    return evidence;
  }

  private async takeoverEvidence(state: AgentState, origin: string): Promise<TakeoverEvidence> {
    const paths = this.takeoverPaths(state);
    const images: (FileImage | null)[] = [];
    if (process.platform === "win32") {
      const observations = new Map<number, SecurityPathObservation>();
      for (const index of [0, 1]) {
        const target = paths[index]!;
        observations.set(index, exists(target) ? await this.privateObservation(target, false) : observeSecurityPath(target));
      }
      await this.windowsImages(paths, undefined, images, observations);
    } else images.push(...await this.images(paths));
    return this.takeoverEvidenceFrom(state, origin, paths, images);
  }

  private takeoverEvidenceFrom(
    state: AgentState,
    origin: string,
    paths: readonly string[],
    images: readonly (FileImage | null)[],
  ): TakeoverEvidence {
    const [configBackupPath, catalogBackupPath, catalogPath, configPath] = paths as readonly [string, string, string, string];
    if (state.targets.length === 0) {
      if (images[0] !== null || images[1] !== null) throw new AgentError("agent_conflict");
      if (images[2] === null && images[3] === null) throw new AgentError("agent_conflict");
    } else {
      const expectedConfigBackup = state.version === 1 ? null : state.targets[0]?.expected ?? null;
      if (!sameImage(images[0]!, expectedConfigBackup)) throw new AgentError("agent_conflict");
      const expectedCatalogBackup = state.version === 3 && state.targets.length === 4
        ? state.targets[1]!.expected : null;
      if (!sameImage(images[1]!, expectedCatalogBackup)) throw new AgentError("agent_conflict");
    }
    const config = images[3] ?? null;
    validateCodexTakeover(config === null ? null : Buffer.from(config.bytes, "base64"));
    return {
      revision: digest({ state, images, paths, origin }),
      configPath,
      catalogPath,
      configBackupPath,
      catalogBackupPath,
      images,
      paths,
    };
  }

  private takeoverPaths(state: AgentState): readonly [string, string, string, string] {
    const configPath = state.targets.at(-1)?.path ?? this.paths.codex.at(-1)!;
    const catalogPath = path.join(path.dirname(configPath), "models.json");
    return [`${configPath}.ghcg.bak`, `${catalogPath}.ghcg.bak`, catalogPath, configPath];
  }

  private async takeoverPrivateObservations(
    paths: readonly string[],
  ): Promise<ReadonlyMap<number, SecurityPathObservation>> {
    const observations = new Map<number, SecurityPathObservation>();
    for (const index of [0, 1]) {
      const target = paths[index]!;
      observations.set(index, exists(target) ? await this.privateObservation(target, false) : observeSecurityPath(target));
    }
    return observations;
  }

  close(): void {
    // Transactions contain at most four 1 MiB files and bounded OS calls.
    this.closed = true;
  }

  private async exclusive<T>(agent: AgentId, work: () => Promise<T>): Promise<T> {
    if (this.closed || this.busy.has(agent)) throw new AgentError("agent_busy");
    this.busy.add(agent);
    try { return await work(); } catch (error: unknown) {
      if (error instanceof AgentError || (error instanceof DOMException && error.name === "AbortError")) throw error;
      throw new AgentError("agent_recovery_required");
    } finally { this.busy.delete(agent); }
  }

  private async status(
    agent: AgentId,
    origin: string,
    inspection?: {
      readonly state?: AgentState;
      readonly paths?: readonly string[];
      readonly images?: readonly (FileImage | null)[];
      readonly takeoverPaths?: readonly string[];
      readonly takeoverImages?: readonly (FileImage | null)[];
      readonly error?: unknown;
    },
  ): Promise<AgentStatus> {
    let state: AgentState | null = null;
    let paths = this.paths[agent];
    let revision = "0".repeat(64);
    let kind: AgentStatus["state"] = "not_managed";
    let backupAvailable = false;
    let takeover: AgentStatus["takeover"] = null;
    const images: (FileImage | null)[] = [];
    try {
      state = inspection?.state ?? await this.store(agent).read();
      paths = inspection?.paths ?? this.fallbackTargetPaths(agent, state);
      if (inspection?.images !== undefined) {
        images.push(...inspection.images);
        backupAvailable = this.backupAvailable(state, images);
        if (inspection.error !== undefined) throw inspection.error;
      } else {
        if (inspection?.error !== undefined) throw inspection.error;
        const validatedPaths: string[] = [];
        try {
          if (process.platform === "win32") {
            let validationError: unknown;
            try {
              for (const target of paths) validatedPaths.push(canonical(target));
            } catch (error: unknown) {
              validationError = error;
            }
            if (validatedPaths.length > 0) await this.images(validatedPaths, state, images);
            if (validationError !== undefined) throw validationError;
          } else {
            for (const [index, target] of paths.entries()) {
              const validated = canonical(target);
              validatedPaths.push(validated);
              images.push(await this.image(validated, index, state));
            }
          }
        } catch (error: unknown) {
          backupAvailable = this.backupAvailable(state, images);
          throw error;
        }
        paths = validatedPaths;
      }
      kind = state.targets.length === 0 ? "not_managed" : state.pending !== null ? "recovery_required" : "installed";
      try {
        if (state.pending !== null) {
          const observed = [...images];
          images.splice(0, images.length);
          const current = await this.requireRecoverable(state, observed, (fresh) => {
            images.splice(0, images.length, ...fresh);
          });
          images.splice(0, images.length, ...current);
        } else this.requireExpected(state, images);
      }
      catch (error: unknown) {
        kind = error instanceof AgentError && error.code === "agent_unsafe_path"
          ? "unsafe_path"
          : state.pending !== null ? "recovery_required" : "conflict";
      }
      revision = this.revision(state, images, paths, origin);
      backupAvailable = this.backupAvailable(state, images);
      if (agent === "codex" && state.pending === null
        && (kind === "conflict" || kind === "not_managed")) {
        try {
          const evidence = inspection?.takeoverPaths !== undefined && inspection.takeoverImages !== undefined
            ? this.takeoverEvidenceFrom(state, origin, inspection.takeoverPaths, inspection.takeoverImages)
            : await this.takeoverEvidence(state, origin);
          takeover = {
            revision: evidence.revision,
            configPath: evidence.configPath,
            catalogPath: evidence.catalogPath,
            configBackupPath: evidence.configBackupPath,
            catalogBackupPath: evidence.catalogBackupPath,
          };
        } catch { /* Unsafe conflicts remain fail closed. */ }
      }
    } catch (error: unknown) {
      kind = error instanceof AgentError && error.code === "agent_unsafe_path" ? "unsafe_path" : "recovery_required";
    }
    return {
      id: agent, state: kind, revision, paths: state !== null && state.version !== 1 && state.targets.length > 0
        ? paths.slice(state.version === 3 && agent === "codex" ? 2 : 1) : paths,
      endpoint: agent === "claude" ? origin : `${origin}/v1`,
      backupAvailable,
      lastAppliedAt: state?.lastAppliedAt ?? null,
      mappings: state?.version === 1 && agent === "claude" ? state.mappings.slice(0, 3) : state?.mappings ?? [],
      takeover,
    };
  }

  private store(agent: AgentId): AgentStore {
    return new AgentStore(this.root, agent, this.legacyRoot);
  }

  private backupAvailable(state: AgentState, images: readonly (FileImage | null)[]): boolean {
    if (state.version === 1 || state.targets.length === 0) return false;
    const step = state.pending?.steps.find((candidate) => candidate.target === 0);
    const image = images[0];
    if (image === undefined || image === null) return false;
    if (!sameImage(image, step?.after ?? state.targets[0]!.expected)) return false;
    if (state.version === 3 && state.targets.length === 4 && state.targets[2]!.original !== null) {
      const catalogStep = state.pending?.steps.find((candidate) => candidate.target === 1);
      return images[1] !== null && sameImage(images[1]!, catalogStep?.after ?? state.targets[1]!.expected);
    }
    return true;
  }

  private fallbackTargetPaths(agent: AgentId, state: AgentState): readonly string[] {
    const targets = state.targets.length === 0 ? this.paths[agent] : state.targets.map((target) => target.path);
    return targets.map((target) => process.platform === "win32" ? path.resolve(target).toLowerCase() : path.resolve(target));
  }
  private targetPaths(agent: AgentId, state: AgentState): readonly string[] {
    return state.targets.length === 0 ? this.paths[agent].map(canonical) : state.targets.map((target) => canonical(target.path));
  }
  private async images(paths: readonly string[], state?: AgentState, images: (FileImage | null)[] = []): Promise<(FileImage | null)[]> {
    if (process.platform === "win32") {
      const privateObservations = state === undefined ? new Map<number, SecurityPathObservation>()
        : await this.privateTargetObservations(state, paths);
      await this.windowsImages(paths, state, images, privateObservations);
      return images;
    }
    for (const [index, target] of paths.entries()) {
      images.push(await this.image(target, index, state));
    }
    return images;
  }
  private async windowsImages(
    paths: readonly string[],
    state: AgentState | undefined,
    images: (FileImage | null)[],
    privateObservations: ReadonlyMap<number, SecurityPathObservation> = new Map(),
  ): Promise<ReadonlyMap<string, SecurityPathSnapshot>> {
    const candidates: string[] = [];
    const parents: string[] = [];
    for (const target of paths) {
      const parent = this.existingParent(target);
      candidates.push(parent, target);
      parents.push(parent);
    }
    const pendingLinks = await this.pendingLinkObservations(state?.pending?.steps ?? []);
    for (const { step } of pendingLinks.values()) {
      candidates.push(step.scratch, path.join(step.scratch, "next"));
      parents.push(step.scratch);
    }
    const snapshots = await this.windowsSecuritySnapshots(candidates, parents);
    for (const [index, observation] of privateObservations) {
      if (!sameSecurityPathObservation(observation,
        this.requireWindowsSnapshot(snapshots, paths[index]!).observation)) throw new AgentError("agent_unsafe_path");
    }
    for (const [index, target] of paths.entries()) {
      const parent = this.existingParent(target);
      images.push(this.readWindowsTargetImage(target, parent, snapshots, pendingLinks.get(index)));
    }
    return snapshots;
  }
  private async image(
    target: string,
    index: number,
    state?: AgentState,
  ): Promise<FileImage | null> {
    let parent = path.dirname(target);
    while (!exists(parent)) parent = path.dirname(parent);
    await assertOwned(parent, true);
    const stage = state?.pending?.steps.find((step) => step.target === index);
    const image = await readImage(target, stage === undefined ? undefined : path.join(stage.scratch, "next"));
    if (state !== undefined && state.version !== 1 && state.targets.length > 0
      && (index === 0 || state.version === 3 && state.targets.length === 4 && index === 1) && image !== null) {
      await assertPrivate(target, false);
    }
    return image;
  }
  private existingParent(target: string): string {
    let parent = path.dirname(target);
    while (!exists(parent)) parent = path.dirname(parent);
    return parent;
  }
  private async windowsSecuritySnapshots(
    paths: readonly string[],
    pathOnly: readonly string[] = [],
  ): Promise<ReadonlyMap<string, SecurityPathSnapshot>> {
    return await this.windowsSecurity.snapshot(paths, pathOnly);
  }
  private requireWindowsSnapshot(
    snapshots: ReadonlyMap<string, SecurityPathSnapshot>,
    target: string,
  ): SecurityPathSnapshot {
    return this.windowsSecurity.require(snapshots, target);
  }
  private consumeWindowsInspection(
    prepared: readonly PreparedInspection[],
    snapshots: ReadonlyMap<string, SecurityPathSnapshot>,
  ): readonly ConsumedInspection[] {
    return prepared.map((item): ConsumedInspection => {
      if (!("paths" in item)) return item;
      if (item.error !== undefined) return { ...item, images: [] };
      const images: (FileImage | null)[] = [];
      const takeoverImages: (FileImage | null)[] = [];
      const validatedPaths: string[] = [];
      try {
        for (const [index, target] of item.paths.entries()) {
          const validated = canonical(target);
          validatedPaths.push(validated);
          let parent = path.dirname(validated);
          while (!exists(parent)) parent = path.dirname(parent);
          const targetSnapshot = this.requireWindowsSnapshot(snapshots, validated);
          const privateObservation = item.privateObservations.get(index);
          if (privateObservation !== undefined
            && !sameSecurityPathObservation(privateObservation, targetSnapshot.observation)) {
            throw new AgentError("agent_unsafe_path");
          }
          const image = this.readWindowsTargetImage(validated, parent, snapshots, item.pendingLinks.get(index));
          images.push(image);
        }
        for (const [index, target] of (item.takeoverPaths ?? []).entries()) {
          const validated = canonical(target);
          const parent = this.existingParent(validated);
          const observation = item.takeoverPrivateObservations?.get(index);
          if (observation !== undefined && !sameSecurityPathObservation(observation,
            this.requireWindowsSnapshot(snapshots, validated).observation)) throw new AgentError("agent_unsafe_path");
          takeoverImages.push(this.readWindowsTargetImage(validated, parent, snapshots));
        }
        return {
          agent: item.agent, state: item.state, paths: validatedPaths, images,
          ...(item.takeoverPaths === undefined ? {} : { takeoverPaths: item.takeoverPaths, takeoverImages }),
        };
      } catch (error: unknown) {
        return { agent: item.agent, state: item.state, paths: item.paths, images, error };
      }
    });
  }
  private revision(state: AgentState, images: readonly (FileImage | null)[], paths: readonly string[], origin: string): string {
    return digest({ state, images, paths, origin });
  }
  private requireRevision(expected: string, state: AgentState, images: readonly (FileImage | null)[], paths: readonly string[], origin: string): void {
    if (expected !== this.revision(state, images, paths, origin)) throw new AgentError("revision_conflict");
  }
  private requireExpected(state: AgentState, images: readonly (FileImage | null)[]): void {
    if (state.targets.some((target, index) => !sameImage(target.expected, images[index]!))) throw new AgentError("agent_conflict");
  }
  private async requireRecoverable(
    state: AgentState,
    images: readonly (FileImage | null)[],
    observeCurrent?: (images: readonly (FileImage | null)[]) => void,
  ): Promise<readonly (FileImage | null)[]> {
    if (state.pending === null) { this.requireExpected(state, images); return images; }
    let current = images;
    if (process.platform === "win32") {
      let validationFailed = false;
      let validationError: unknown;
      try {
        for (const step of state.pending.steps) await this.validateDisplaced(step);
      } catch (error: unknown) {
        validationFailed = true;
        validationError = error;
      }
      current = await this.images(state.targets.map((target) => target.path), state);
      observeCurrent?.(current);
      if (validationFailed) throw validationError;
      for (const step of state.pending.steps) this.classify(step, current[step.target]!);
    } else {
      for (const step of state.pending.steps) {
        await this.validateDisplaced(step);
        this.classify(step, current[step.target]!);
      }
    }
    for (const [index, target] of state.targets.entries()) {
      if (!state.pending.steps.some((step) => step.target === index) && !sameImage(target.expected, current[index]!)) throw new AgentError("agent_conflict");
    }
    return current;
  }
  private async validateDisplaced(step: StepState): Promise<void> {
    const displaced = path.join(step.scratch, "previous");
    if (exists(displaced)) {
      const privateObservation = await this.privateObservation(step.scratch, true);
      const saved = await this.privateChildImage(step.scratch, displaced, undefined, privateObservation);
      if (saved?.bytes !== step.before?.bytes) throw new AgentError("agent_recovery_required");
    }
  }
  private classify(step: StepState, image: FileImage | null): "before" | "after" | "gap" {
    const displaced = path.join(step.scratch, "previous");
    if (sameImage(image, step.after) && (step.phase !== "planned" || !sameImage(step.before, step.after))) return "after";
    if (sameImage(image, step.before)) return "before";
    if (image === null && step.before !== null && exists(displaced)) return "gap";
    throw new AgentError("agent_recovery_required");
  }

  private plan(agent: AgentId, state: AgentState, before: readonly (FileImage | null)[], after: readonly (FileImage | null)[]): StepState[] {
    return state.targets.map((target, index): StepState => ({
      target: index, before: before[index]!, after: after[index]!, phase: "planned",
      scratch: path.join(path.dirname(target.path), `.ghcg-agents-${agent}-${randomUUID()}`),
    })).filter((step) => !sameImage(step.before, step.after));
  }

  private async execute(agent: AgentId, state: AgentState, save: (state: AgentState) => Promise<void>): Promise<void> {
    const pending = state.pending!;
    // Backup, catalog, then config.
    const steps = pending.steps;
    const positions = new Map<StepState, "before" | "after" | "gap">();
    for (const step of steps) {
      const target = state.targets[step.target]!.path;
      assertNoLinks(target);
      const stage = path.join(step.scratch, "next");
      await this.validateDisplaced(step);
      const position = this.classify(step, await this.securityImage(target, step));
      positions.set(step, position);
      if (position === "after") { step.phase = "published"; await save(state); continue; }
      await this.ensureClientParent(path.dirname(target));
      await privateDirectory(step.scratch);
      if (step.after !== null) {
        const intended = step.after;
        const staged = await this.privateChildImage(step.scratch, stage, target);
        if (staged === null) {
          await writeExclusive(stage, intended);
          this.hit("stage_written", agent, step.target);
        } else if (!sameImage(staged, intended)) {
          if (step.phase !== "planned" || staged.bytes !== intended.bytes) throw new AgentError("agent_recovery_required");
          // A crash may precede journaling the descriptor assigned to a new stage.
          // Verify payload/ownership and reapply intended access before adopting it.
          await applyAccess(stage, intended);
        }
        const observed = await this.privateChildImage(step.scratch, stage, target);
        if (observed === null || observed.bytes !== intended.bytes
          || (process.platform !== "win32" && observed.mode !== intended.mode)) throw new AgentError("agent_recovery_required");
        if (!sameImage(observed, intended)) {
          step.after = observed;
          await save(state);
        }
      }
      this.hit("staged", agent, step.target);
    }
    const boundary = await this.images(state.targets.map((target) => target.path), state);
    if ([...positions.values()].every((position) => position === "before")) this.requireExpected(state, boundary);
    else await this.requireRecoverable(state, boundary);
    for (const step of steps) {
      let position = positions.get(step)!;
      if (position === "after") continue;
      const target = state.targets[step.target]!.path;
      const stage = path.join(step.scratch, "next");
      const displaced = path.join(step.scratch, "previous");
      if (position === "before" && step.before !== null) {
        // Staging and journal writes may take time. Revalidate the full live
        // image immediately before moving it, then prove rename displaced the
        // same filesystem object. This catches pathname replacements as well as
        // content/access changes without trusting a stale pre-staging read.
        if (process.platform === "win32") {
          const privateObservation = observeSecurityPath(step.scratch);
          const entries = fs.readdirSync(step.scratch);
          const expectedEntries = step.after === null ? [] : ["next"];
          const parent = this.existingParent(target);
          const snapshots = await this.windowsSecuritySnapshots(
            [step.scratch, stage, parent, displaced, target],
            [step.scratch, parent],
          );
          const afterEntries = fs.readdirSync(step.scratch);
          if (!sameSecurityPathIdentity(privateObservation, this.requireWindowsSnapshot(snapshots, step.scratch).observation)
            || this.requireWindowsSnapshot(snapshots, displaced).fact.status !== "missing"
            || entries.length !== expectedEntries.length || entries.some((entry, index) => entry !== expectedEntries[index])
            || afterEntries.length !== expectedEntries.length
            || afterEntries.some((entry, index) => entry !== expectedEntries[index])) {
            throw new AgentError("agent_recovery_required");
          }
          const live = this.readWindowsTargetImage(target, parent, snapshots,
            { step, scratch: privateObservation }, true);
          if (!sameImage(live, step.before)) throw new AgentError("agent_conflict");
        } else {
          if (exists(displaced)) throw new AgentError("agent_recovery_required");
          if (!sameImage(await readImage(target, stage), step.before)) throw new AgentError("agent_conflict");
        }
        const beforeMove = fs.lstatSync(target);
        fs.renameSync(target, displaced);
        const afterMove = fs.lstatSync(displaced);
        syncDirectory(path.dirname(target));
        syncDirectory(step.scratch);
        const actual = await this.privateChildImage(step.scratch, displaced);
        const matches = beforeMove.dev === afterMove.dev && beforeMove.ino === afterMove.ino
          && sameDisplacedContent(actual, step.before);
        await protect(displaced);
        if (!matches) throw new AgentError("agent_recovery_required");
        step.phase = "displaced";
        await save(state);
        this.hit("displaced", agent, step.target);
        position = "gap";
      }
      if (step.after !== null) {
        const staged = await this.privateChildImage(step.scratch, stage, target);
        if (!sameImage(staged, step.after)) throw new AgentError("agent_recovery_required");
        // link is a no-clobber publication on NTFS/APFS/ext4; unsupported filesystems
        // safely fail with both baseline and displaced bytes retained.
        fs.linkSync(stage, target);
        this.hit("linked", agent, step.target);
        fs.unlinkSync(stage);
      } else if (position === "before" && step.before === null && exists(target)) {
        throw new AgentError("agent_recovery_required");
      }
      syncDirectory(path.dirname(target));
      step.phase = "published";
      await save(state);
      this.hit("published", agent, step.target);
    }
  }

  private async finish(agent: AgentId, state: AgentState, save: (state: AgentState) => Promise<void>): Promise<void> {
    const pending = state.pending!;
    if (process.platform === "win32") {
      const published = await this.images(state.targets.map((target) => target.path), state);
      for (const step of pending.steps) {
        if (!sameImage(published[step.target]!, step.after)) throw new AgentError("agent_recovery_required");
        state.targets[step.target]!.expected = step.after;
      }
    } else {
      for (const step of pending.steps) {
        const target = state.targets[step.target]!;
        if (!sameImage(await readImage(target.path, path.join(step.scratch, "next")), step.after)) {
          throw new AgentError("agent_recovery_required");
        }
        target.expected = step.after;
      }
    }
    // Keep the durable baseline until all file publications have been verified.
    // Cleanup happens while the intent is still present, and can be retried.
    for (const step of pending.steps) await this.cleanup(step.scratch, state.targets[step.target]?.path);
    for (const scratch of pending.garbage) await this.cleanup(scratch);
    if (pending.kind === "restore") {
      state.targets = [];
      state.mappings = [];
      state.lastAppliedAt = null;
    }
    state.pending = null;
    state.revision += 1;
    await save(state);
    this.hit("complete", agent, -1);
  }

  private async cleanup(scratch: string, liveTarget?: string): Promise<void> {
    if (!exists(scratch)) return;
    if (process.platform !== "win32") {
      await assertPrivate(scratch, true);
      if (fs.readdirSync(scratch).some((entry) => entry !== "previous" && entry !== "next")) {
        throw new AgentError("agent_recovery_required");
      }
      for (const name of ["previous", "next"]) {
        const target = path.join(scratch, name);
        if (exists(target)) {
          await assertOwned(target, false, name === "next" ? liveTarget : undefined);
          fs.unlinkSync(target);
        }
      }
      fs.rmdirSync(scratch);
      syncDirectory(path.dirname(scratch));
      return;
    }
    const privateObservation = await this.privateObservation(scratch, true);
    const entries = fs.readdirSync(scratch);
    if (entries.some((entry) => entry !== "previous" && entry !== "next")) throw new AgentError("agent_recovery_required");
    const expected = new Set(entries);
    // No recursive deletion of an unvalidated directory tree.
    for (const name of ["previous", "next"]) {
      const target = path.join(scratch, name);
      if (expected.has(name)) {
        const snapshots = await this.windowsSecuritySnapshots(liveTarget === undefined || name !== "next"
          ? [scratch, target]
          : [scratch, target, liveTarget], [scratch]);
        if (!sameSecurityPathIdentity(privateObservation, this.requireWindowsSnapshot(snapshots, scratch).observation)) {
          throw new AgentError("agent_unsafe_path");
        }
        assertOwnedFromSecuritySnapshot(target, false, this.requireWindowsSnapshot(snapshots, target),
          name === "next" && liveTarget !== undefined
            ? this.allowedLink(snapshots, liveTarget)
            : undefined);
        fs.unlinkSync(target);
      } else if (exists(target)) {
        throw new AgentError("agent_recovery_required");
      }
    }
    if (!sameSecurityPathIdentity(privateObservation, observeSecurityPath(scratch))
      || fs.readdirSync(scratch).length !== 0) throw new AgentError("agent_recovery_required");
    fs.rmdirSync(scratch);
    syncDirectory(path.dirname(scratch));
  }
  private async ensureClientParent(directory: string): Promise<void> {
    assertNoLinks(directory);
    if (exists(directory)) {
      if (process.platform === "win32") {
        const snapshots = await this.windowsSecuritySnapshots([directory], [directory]);
        assertOwnedFromSecuritySnapshot(directory, true, this.requireWindowsSnapshot(snapshots, directory));
      } else await assertOwned(directory, true);
      return;
    }
    await this.ensureClientParent(path.dirname(directory));
    fs.mkdirSync(directory, { mode: 0o700 });
    // Never chmod or change ACLs of an existing client directory.
    if (process.platform === "win32") {
      const snapshots = await this.windowsSecuritySnapshots([directory], [directory]);
      assertOwnedFromSecuritySnapshot(directory, true, this.requireWindowsSnapshot(snapshots, directory));
    } else await assertOwned(directory, true);
    syncDirectory(path.dirname(directory));
  }
  private async securityImage(target: string, step: StepState): Promise<FileImage | null> {
    const stage = path.join(step.scratch, "next");
    if (process.platform !== "win32") return await readImage(target, stage);
    const pendingLinks = await this.pendingLinkObservations([step]);
    const link = pendingLinks.get(step.target);
    const parent = this.existingParent(target);
    const candidates = [parent, target];
    if (link !== undefined) candidates.push(step.scratch, stage);
    const pathOnly = link === undefined ? [parent] : [parent, step.scratch];
    const snapshots = await this.windowsSecuritySnapshots(candidates, pathOnly);
    return this.readWindowsTargetImage(target, parent, snapshots, link);
  }
  private async privateObservation(target: string, directory: boolean): Promise<SecurityPathObservation> {
    const observation = observeSecurityPath(target);
    await assertPrivate(target, directory);
    assertSecurityPathUnchanged(target, observation, directory);
    return observation;
  }
  private async privateTargetObservations(
    state: AgentState,
    paths: readonly string[],
  ): Promise<ReadonlyMap<number, SecurityPathObservation>> {
    const observations = new Map<number, SecurityPathObservation>();
    if (state.version === 1 || state.targets.length === 0) return observations;
    const indexes = state.version === 3 && state.targets.length === 4 ? [0, 1] : [0];
    for (const index of indexes) {
      if (paths[index] !== state.targets[index]?.path) continue;
      const target = paths[index]!;
      observations.set(index, exists(target) ? await this.privateObservation(target, false) : observeSecurityPath(target));
    }
    return observations;
  }
  private async privateChildImage(
    parent: string,
    target: string,
    allowedLink?: string,
    expectedParent?: SecurityPathObservation,
  ): Promise<FileImage | null> {
    if (process.platform !== "win32") return await readImage(target, allowedLink);
    const snapshots = await this.windowsSecuritySnapshots(allowedLink === undefined
      ? [parent, target]
      : [parent, target, allowedLink], [parent]);
    if (expectedParent !== undefined && !sameSecurityPathIdentity(expectedParent,
      this.requireWindowsSnapshot(snapshots, parent).observation)) {
      throw new AgentError("agent_unsafe_path");
    }
    return readImageFromSecuritySnapshot(target, this.requireWindowsSnapshot(snapshots, target),
      allowedLink === undefined ? undefined : this.allowedLink(snapshots, allowedLink));
  }
  private async pendingLinkObservations(steps: readonly StepState[]): Promise<ReadonlyMap<number, PendingLinkObservation>> {
    const observations = new Map<number, PendingLinkObservation>();
    for (const step of steps) {
      if (!exists(step.scratch)) continue;
      observations.set(step.target, { step, scratch: observeSecurityPath(step.scratch) });
    }
    return observations;
  }
  private readWindowsTargetImage(
    target: string,
    parent: string,
    snapshots: ReadonlyMap<string, SecurityPathSnapshot>,
    pendingLink?: PendingLinkObservation,
    requireStage = false,
  ): FileImage | null {
    assertOwnedFromSecuritySnapshot(parent, true, this.requireWindowsSnapshot(snapshots, parent));
    const targetSnapshot = this.requireWindowsSnapshot(snapshots, target);
    let allowedLink: SecurityPathAllowedLink | undefined;
    if (pendingLink !== undefined && (requireStage || targetSnapshot.observation.nlink === 2)) {
      if (!sameSecurityPathIdentity(pendingLink.scratch,
        this.requireWindowsSnapshot(snapshots, pendingLink.step.scratch).observation)) {
        throw new AgentError("agent_unsafe_path");
      }
      const stage = path.join(pendingLink.step.scratch, "next");
      const stageSnapshot = this.requireWindowsSnapshot(snapshots, stage);
      const staged = readImageFromSecuritySnapshot(stage, stageSnapshot,
        this.allowedLink(snapshots, target));
      if (!sameImage(staged, pendingLink.step.after)) throw new AgentError("agent_recovery_required");
      if (staged !== null) {
        allowedLink = { target: stage, snapshot: stageSnapshot };
      }
    }
    return readImageFromSecuritySnapshot(target, targetSnapshot, allowedLink);
  }
  private allowedLink(
    snapshots: ReadonlyMap<string, SecurityPathSnapshot>,
    target: string,
  ): SecurityPathAllowedLink | undefined {
    const snapshot = this.requireWindowsSnapshot(snapshots, target);
    return snapshot.fact.status === "missing" ? undefined : { target, snapshot };
  }
  private hit(point: Parameters<NonNullable<AgentManagerOptions["checkpoint"]>>[0], agent: AgentId, index: number): void {
    this.options.checkpoint?.(point, agent, index);
  }
  private requireCurrent(agent: AgentId, assertCurrent: () => void, signal: AbortSignal): void {
    this.hit("before_intent", agent, -1);
    signal.throwIfAborted();
    assertCurrent();
  }
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((target, index) => target === right[index]);
}

function sameFilePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((target, index) => {
    const other = right[index];
    if (other === undefined) return false;
    const resolved = path.resolve(target);
    const resolvedOther = path.resolve(other);
    return process.platform === "win32" ? resolved.toLowerCase() === resolvedOther.toLowerCase() : resolved === resolvedOther;
  });
}
