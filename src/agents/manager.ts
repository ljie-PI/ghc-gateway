import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { AgentError, validateMappings, type AgentId, type AgentStatus, type AgentsManager, type AgentApplyRequest, type AgentRestoreRequest, type AgentModel } from "./types.js";
import { AgentStore, copyMappings, newImage, type AgentState, type StepState } from "./store.js";
import { assertNoLinks, assertOwned, assertPrivate, canonical, digest, exists, privateDirectory, protect, readImage, sameDisplacedContent, sameImage, syncDirectory, writeExclusive, type FileImage } from "./files.js";
import { projectAgent } from "./transform.js";

export interface AgentManagerOptions {
  readonly home?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly now?: () => Date;
  /** Deterministic failure/race injection at durable transaction boundaries. */
  readonly checkpoint?: (point: "intent" | "staged" | "displaced" | "linked" | "published" | "complete", agent: AgentId, index: number) => void;
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
      codex: [path.join(codex, "ghcg-models.json"), path.join(codex, "config.toml")],
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
      if (initial.pending !== null) throw new AgentError("agent_recovery_required");
      const paths = this.targetPaths(request.agent, initial);
      const before = await this.images(paths);
      this.requireRevision(request.expectedRevision, initial, before, paths, origin);
      this.requireExpected(initial, before);
      const configIndex = request.agent === "claude" ? 0 : 1;
      const config = initial.targets.length === 0 ? before[configIndex]! : initial.targets[configIndex]!.original;
      const projection = projectAgent(request.agent, config === null ? null : Buffer.from(config.bytes, "base64"), request.mappings, origin, paths[0]!, models);
      signal.throwIfAborted();
      assertCurrent();
      return await store.locked(async (save) => {
        const state = await store.read();
        const current = await this.images(paths);
        this.requireRevision(request.expectedRevision, state, current, paths, origin);
        this.requireExpected(state, current);
        assertCurrent();
        signal.throwIfAborted();
        if (state.targets.length === 0) {
          state.targets = paths.map((target, index) => ({ path: target, original: current[index]!, expected: current[index]! }));
        }
        const after = request.agent === "claude"
          ? [newImage(projection.config, state.targets[0]!.original)]
          : [newImage(projection.catalog!, state.targets[0]!.original), newImage(projection.config, state.targets[1]!.original)];
        state.pending = { kind: "apply", steps: this.plan(request.agent, state, current, after), garbage: [] };
        state.mappings = copyMappings(request.mappings);
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

  async restore(request: AgentRestoreRequest, origin: string, signal: AbortSignal): Promise<AgentStatus> {
    return await this.exclusive(request.agent, async () => {
      signal.throwIfAborted();
      const store = new AgentStore(this.root, request.agent);
      const initial = await store.read();
      if (initial.targets.length === 0) throw new AgentError("validation_failed");
      const paths = this.targetPaths(request.agent, initial);
      const current = await this.images(paths, initial);
      this.requireRevision(request.expectedRevision, initial, current, paths, origin);
      await this.requireRecoverable(initial, current);
      signal.throwIfAborted();
      return await store.locked(async (save) => {
        const state = await store.read();
        const before = await this.images(paths, state);
        this.requireRevision(request.expectedRevision, state, before, paths, origin);
        await this.requireRecoverable(state, before);
        signal.throwIfAborted();
        if (state.pending?.kind !== "restore") {
          const garbage = state.pending?.steps.map((step) => step.scratch) ?? [];
          await this.releasePublishedStageLinks(state);
          state.pending = {
            kind: "restore", garbage,
            steps: this.plan(request.agent, state, before, state.targets.map((target) => target.original)),
          };
          await save(state);
          this.hit("intent", request.agent, -1);
        }
        await this.execute(request.agent, state, save);
        await this.finish(request.agent, state, save);
        return await this.status(request.agent, origin);
      });
    });
  }

  close(): void {
    // Mutations are synchronous, bounded by two 1 MiB files and bounded OS calls.
    // No background queue or automatic shutdown restore exists.
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
    let canRestore = false;
    try {
      state = await new AgentStore(this.root, agent).read();
      paths = this.targetPaths(agent, state);
      const images = await this.images(paths, state);
      revision = this.revision(state, images, paths, origin);
      kind = state.targets.length === 0 ? "not_managed" : state.pending !== null ? "recovery_required" : "installed";
      try { await this.requireRecoverable(state, images); canRestore = state.targets.length > 0; }
      catch { kind = state.pending !== null ? "recovery_required" : "conflict"; }
    } catch (error: unknown) {
      kind = error instanceof AgentError && error.code === "agent_unsafe_path" ? "unsafe_path" : "recovery_required";
    }
    return {
      id: agent, state: kind, revision, paths, endpoint: agent === "claude" ? origin : `${origin}/v1`,
      backupAvailable: (state?.targets.length ?? 0) > 0, lastAppliedAt: state?.lastAppliedAt ?? null,
      mappings: state?.mappings ?? [], canRestore,
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
    return state.targets.map((target, index) => ({
      target: index, before: before[index]!, after: after[index]!, phase: "planned",
      scratch: path.join(path.dirname(target.path), `.ghcg-agents-${agent}-${randomUUID()}`),
    }));
  }

  private async execute(agent: AgentId, state: AgentState, save: (state: AgentState) => Promise<void>): Promise<void> {
    const pending = state.pending!;
    // Catalog first when applying; configuration reference first when restoring.
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
      if (step.after !== null && !exists(stage)) {
        await writeExclusive(stage, step.after);
        step.after = (await readImage(stage))!;
        await save(state);
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
  private async releasePublishedStageLinks(state: AgentState): Promise<void> {
    for (const step of state.pending?.steps ?? []) {
      const target = state.targets[step.target]?.path;
      const stage = path.join(step.scratch, "next");
      if (target === undefined || !exists(target) || !exists(stage)) continue;
      const targetStat = fs.lstatSync(target);
      const stageStat = fs.lstatSync(stage);
      if (targetStat.dev !== stageStat.dev || targetStat.ino !== stageStat.ino) continue;
      if (!sameImage(await readImage(target, stage), step.after)) throw new AgentError("agent_recovery_required");
      await assertOwned(stage, false, target);
      fs.unlinkSync(stage);
      syncDirectory(step.scratch);
    }
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
