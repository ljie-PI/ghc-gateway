import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { AgentError, validateMappings, type AgentId, type AgentStatus, type AgentsManager, type AgentApplyRequest, type AgentModel } from "./types.js";
import { AgentStore, copyMappings, newImage, type AgentState, type StepState } from "./store.js";
import { applyAccess, assertNoLinks, assertOwned, assertPrivate, canonical, digest, exists, privateDirectory, protect, readImage, sameDisplacedContent, sameImage, syncDirectory, writeExclusive, type FileImage } from "./files.js";
import { projectAgent } from "./transform.js";

export interface AgentManagerOptions {
  readonly home?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly now?: () => Date;
  /** Deterministic failure/race injection at durable transaction boundaries. */
  readonly checkpoint?: (point: "intent" | "stage_written" | "staged" | "displaced" | "linked" | "published" | "complete", agent: AgentId, index: number) => void;
}

export class FileAgentsManager implements AgentsManager {
  private readonly home: string;
  private readonly root: string;
  private readonly paths: Record<AgentId, readonly string[]>;
  private readonly busy = new Set<AgentId>();
  private closed = false;

  constructor(private readonly options: AgentManagerOptions = {}) {
    // Resolve the existing home anchor once. macOS exposes its temporary home
    // paths through the system /var -> /private/var alias; canonicalizing that
    // trusted anchor avoids rejecting the OS alias while links below it remain
    // forbidden. A durable baseline pins its own target paths.
    this.home = fs.realpathSync.native(path.resolve(options.home ?? os.homedir()));
    this.root = path.join(this.home, ".ghc-gateway-agents");
    const env = options.env ?? {};
    const claude = path.resolve(env.CLAUDE_CONFIG_DIR ?? path.join(this.home, ".claude"));
    const codex = path.resolve(env.CODEX_HOME ?? path.join(this.home, ".codex"));
    this.paths = {
      claude: [path.join(claude, "settings.json")],
      codex: [path.join(codex, "ghcg_models.json"), path.join(codex, "config.toml")],
    };
  }

  async inspect(origin: string): Promise<readonly AgentStatus[]> {
    return await Promise.all((["claude", "codex"] as const).map((agent) => this.status(agent, origin)));
  }

  async apply(request: AgentApplyRequest, origin: string, models: readonly AgentModel[], assertCurrent: () => void, signal: AbortSignal): Promise<AgentStatus> {
    return await this.exclusive(request.agent, async () => {
      signal.throwIfAborted();
      validateMappings(request.agent, request.mappings);
      const store = new AgentStore(this.root, request.agent);
      // Parse and validate BEFORE making a recovery directory or lock file.
      const initial = await store.read();
      const paths = this.targetPaths(request.agent, initial);
      const before = await this.images(paths, initial);
      this.requireRevision(request.expectedRevision, initial, before, paths, origin);
      if (initial.pending === null) this.project(request, before, paths, origin, models);
      signal.throwIfAborted();
      assertCurrent();
      return await store.locked(async (save) => {
        const state = await store.read();
        let current = await this.images(paths, state);
        this.requireRevision(request.expectedRevision, state, current, paths, origin);
        assertCurrent();
        signal.throwIfAborted();
        if (state.pending !== null) {
          // Resume only the already-durable transaction, never a new restore.
          await this.requireRecoverable(state, current);
          await this.execute(request.agent, state, save);
          await this.finish(request.agent, state, save);
        }
        const livePaths = this.targetPaths(request.agent, state);
        current = await this.images(livePaths);
        if (initial.pending === null) this.requireRevision(request.expectedRevision, state, current, livePaths, origin);
        const projection = this.project(request, current, livePaths, origin, models);
        const prepared = await this.prepareTargets(request.agent, state, current, livePaths);
        current = prepared.current;
        assertCurrent();
        signal.throwIfAborted();
        const after = request.agent === "claude"
          ? [prepared.backup, newImage(projection.config, current[1]!)]
          : [prepared.backup, newImage(projection.catalog!, current[1]!), newImage(projection.config, current[2]!)];
        const steps = this.plan(request.agent, state, current, after);
        for (const [index, target] of state.targets.entries()) target.expected = current[index]!;
        state.mappings = copyMappings(request.mappings);
        if (steps.length === 0) {
          state.lastAppliedAt = (this.options.now ?? (() => new Date()))().toISOString();
          state.revision += 1;
          await save(state);
          return await this.status(request.agent, origin);
        }
        state.pending = { kind: "apply", steps, garbage: [] };
        // From this durable intent onward cancellation must not interrupt commit.
        await save(state);
        this.hit("intent", request.agent, -1);
        await this.execute(request.agent, state, save);
        state.lastAppliedAt = (this.options.now ?? (() => new Date()))().toISOString();
        await this.finish(request.agent, state, save);
        return await this.status(request.agent, origin);
      });
    });
  }

  private project(request: AgentApplyRequest, images: readonly (FileImage | null)[], paths: readonly string[], origin: string, models: readonly AgentModel[]) {
    const config = images.at(-1) ?? null;
    const catalogPath = path.join(path.dirname(paths.at(-1)!), "ghcg_models.json");
    return projectAgent(request.agent, config === null ? null : Buffer.from(config.bytes, "base64"), request.mappings, origin, catalogPath, models);
  }

  private async prepareTargets(agent: AgentId, state: AgentState, current: (FileImage | null)[], paths: readonly string[]) {
    if (state.version === 2 && state.targets.length > 0) {
      await this.requireBackup(state, current);
      return { current, backup: state.targets[0]!.expected };
    }
    const configPath = paths.at(-1)!;
    const original = state.targets.length === 0 ? current.at(-1)! : state.targets.at(-1)!.original;
    const backupPath = `${configPath}.ghcg.bak`;
    const existing = await readImage(backupPath);
    if (existing !== null) {
      await assertPrivate(backupPath, false);
      if (existing.bytes !== original?.bytes) throw new AgentError("agent_conflict");
    }
    const clientPaths = agent === "claude" ? [configPath] : [path.join(path.dirname(configPath), "ghcg_models.json"), configPath];
    const clientImages = await this.images(clientPaths);
    if (!sameImage(clientImages.at(-1)!, current.at(-1)!)) throw new AgentError("agent_conflict");
    if (state.targets.length > 0 && agent === "codex" && paths[0] !== clientPaths[0]) {
      if (clientImages[0] !== null) throw new AgentError("agent_conflict");
      state.legacyCatalog = state.targets[0]!;
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
    };
  }

  private async requireBackup(state: AgentState, images: readonly (FileImage | null)[]): Promise<void> {
    if (state.version !== 2 || state.targets.length === 0) return;
    if (!sameImage(state.targets[0]!.expected, images[0]!)) throw new AgentError("agent_conflict");
    if (images[0] !== null) await assertPrivate(state.targets[0]!.path, false);
  }

  close(): void {
    // Transactions contain at most three 1 MiB files and bounded OS calls.
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

  private async status(agent: AgentId, origin: string): Promise<AgentStatus> {
    let state: AgentState | null = null;
    let paths = this.paths[agent];
    let revision = "0".repeat(64);
    let kind: AgentStatus["state"] = "not_managed";
    try {
      state = await new AgentStore(this.root, agent).read();
      paths = this.targetPaths(agent, state);
      const images = await this.images(paths, state);
      revision = this.revision(state, images, paths, origin);
      kind = state.targets.length === 0 ? "not_managed" : state.pending !== null ? "recovery_required" : "installed";
      try {
        if (state.pending !== null) await this.requireRecoverable(state, images);
        else {
          await this.requireBackup(state, images);
          this.requireExpected(state, images);
        }
      }
      catch { kind = state.pending !== null ? "recovery_required" : "conflict"; }
    } catch (error: unknown) {
      kind = error instanceof AgentError && error.code === "agent_unsafe_path" ? "unsafe_path" : "recovery_required";
    }
    return {
      id: agent, state: kind, revision, paths: state?.version === 2 && state.targets.length > 0 ? paths.slice(1) : paths,
      endpoint: agent === "claude" ? origin : `${origin}/v1`,
      backupAvailable: state?.version === 2 ? state.targets[0]?.expected !== null && state.targets[0]?.expected !== undefined
        : (state?.targets.length ?? 0) > 0,
      lastAppliedAt: state?.lastAppliedAt ?? null,
      mappings: state?.version === 1 && agent === "claude" ? state.mappings.slice(0, 3) : state?.mappings ?? [],
    };
  }

  private targetPaths(agent: AgentId, state: AgentState): readonly string[] {
    return state.targets.length === 0 ? this.paths[agent].map(canonical) : state.targets.map((target) => canonical(target.path));
  }
  private async images(paths: readonly string[], state?: AgentState): Promise<(FileImage | null)[]> {
    // Client files usually share a parent directory; verify each distinct one once.
    const parents = new Set(paths.map((target) => {
      let parent = path.dirname(target);
      while (!exists(parent)) parent = path.dirname(parent);
      return parent;
    }));
    for (const parent of parents) await assertOwned(parent, true);
    return await Promise.all(paths.map(async (target, index) => {
      const stage = state?.pending?.steps.find((step) => step.target === index);
      return await readImage(target, stage === undefined ? undefined : path.join(stage.scratch, "next"));
    }));
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
  private async requireRecoverable(state: AgentState, images: readonly (FileImage | null)[]): Promise<void> {
    if (state.pending === null) { this.requireExpected(state, images); return; }
    for (const step of state.pending.steps) await this.classify(step, images[step.target]!);
    for (const [index, target] of state.targets.entries()) {
      if (!state.pending.steps.some((step) => step.target === index) && !sameImage(target.expected, images[index]!)) throw new AgentError("agent_conflict");
    }
  }
  private async classify(step: StepState, image: FileImage | null): Promise<"before" | "after" | "gap"> {
    const displaced = path.join(step.scratch, "previous");
    if (exists(displaced)) {
      await assertPrivate(step.scratch, true);
      const saved = await readImage(displaced);
      if (saved?.bytes !== step.before?.bytes) throw new AgentError("agent_recovery_required");
    }
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
    // Backup, catalog, then config. Legacy restore intents retain their stored ordering.
    const steps = pending.kind === "restore" ? [...pending.steps].reverse() : pending.steps;
    for (const step of steps) {
      const target = state.targets[step.target]!.path;
      assertNoLinks(target);
      const stage = path.join(step.scratch, "next");
      const displaced = path.join(step.scratch, "previous");
      let position = await this.classify(step, await readImage(target, stage));
      if (position === "after") { step.phase = "published"; await save(state); continue; }
      await this.ensureClientParent(path.dirname(target));
      await privateDirectory(step.scratch);
      if (step.after !== null) {
        const intended = step.after;
        const staged = await readImage(stage);
        if (staged === null) {
          await writeExclusive(stage, intended);
          this.hit("stage_written", agent, step.target);
        } else if (!sameImage(staged, intended)) {
          if (step.phase !== "planned" || staged.bytes !== intended.bytes) throw new AgentError("agent_recovery_required");
          // A crash may precede journaling the descriptor assigned to a new stage.
          // Verify payload/ownership and reapply intended access before adopting it.
          await applyAccess(stage, intended);
        }
        const observed = await readImage(stage);
        if (observed === null || observed.bytes !== intended.bytes
          || (process.platform !== "win32" && observed.mode !== intended.mode)) throw new AgentError("agent_recovery_required");
        if (!sameImage(observed, intended)) {
          step.after = observed;
          await save(state);
        }
      }
      this.hit("staged", agent, step.target);
      if (position === "before" && step.before !== null) {
        if (exists(displaced)) throw new AgentError("agent_recovery_required");
        // Staging and journal writes may take time. Revalidate the full live
        // image immediately before moving it, then prove rename displaced the
        // same filesystem object. This catches pathname replacements as well as
        // content/access changes without trusting a stale pre-staging read.
        if (!sameImage(await readImage(target, stage), step.before)) throw new AgentError("agent_conflict");
        const beforeMove = fs.lstatSync(target);
        fs.renameSync(target, displaced);
        const afterMove = fs.lstatSync(displaced);
        syncDirectory(path.dirname(target));
        syncDirectory(step.scratch);
        const actual = await readImage(displaced);
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
        const staged = await readImage(stage);
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
    for (const step of pending.steps) {
      const target = state.targets[step.target]!;
      if (!sameImage(await readImage(target.path, path.join(step.scratch, "next")), step.after)) throw new AgentError("agent_recovery_required");
      target.expected = step.after;
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
    await assertPrivate(scratch, true);
    if (fs.readdirSync(scratch).some((entry) => entry !== "previous" && entry !== "next")) throw new AgentError("agent_recovery_required");
    // No recursive deletion of an unvalidated directory tree.
    for (const name of ["previous", "next"]) {
      const target = path.join(scratch, name);
      if (exists(target)) {
        await assertOwned(target, false, name === "next" ? liveTarget : undefined);
        fs.unlinkSync(target);
      }
    }
    fs.rmdirSync(scratch);
    syncDirectory(path.dirname(scratch));
  }
  private async ensureClientParent(directory: string): Promise<void> {
    assertNoLinks(directory);
    if (exists(directory)) { await assertOwned(directory, true); return; }
    await this.ensureClientParent(path.dirname(directory));
    fs.mkdirSync(directory, { mode: 0o700 });
    // Never chmod or change ACLs of an existing client directory.
    await assertOwned(directory, true);
    syncDirectory(path.dirname(directory));
  }
  private hit(point: Parameters<NonNullable<AgentManagerOptions["checkpoint"]>>[0], agent: AgentId, index: number): void {
    this.options.checkpoint?.(point, agent, index);
  }
}
