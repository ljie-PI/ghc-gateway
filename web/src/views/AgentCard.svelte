<script lang="ts">
  import { errorMessage, type AdminClient } from "../api.js";
  import type { AgentMapping, AgentStatus } from "../../../src/agents/types.js";

  let { client, status, catalogRevision, onchanged }: {
    client: AdminClient; status: AgentStatus; catalogRevision: string | null; onchanged: (status: AgentStatus) => void;
  } = $props();
  const title = $derived(status.id === "claude" ? "Claude Code" : "Codex");
  let drafts: AgentMapping[] = $state([]);
  let baseline = $state("");
  let loadedRevision = $state("");
  let busy = $state(false);
  let failure = $state("");
  let notice = $state("");
  const dirty = $derived(JSON.stringify(drafts) !== baseline);
  const valid = $derived(drafts.length > 0 && drafts.every((row) => row.displayName.trim().length > 0
    && row.displayName.length <= 80 && !/[\p{C}]/u.test(row.displayName)
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(row.modelId))
    && (status.id !== "codex" || new Set(drafts.map((row) => row.modelId)).size === drafts.length));
  const applyAllowed = $derived(status.state === "not_managed" || status.state === "installed");
  const stateLabel = $derived({
    not_managed: "Not managed", installed: "Configuration installed", conflict: "External changes detected",
    recovery_required: "Recovery required", unsafe_path: "Unsupported or unsafe path",
  }[status.state]);

  $effect(() => {
    if (loadedRevision !== status.revision) {
      if (loadedRevision === "" || !dirty) resetDrafts();
      loadedRevision = status.revision;
    }
  });
  function resetDrafts(): void {
    drafts = status.mappings.length > 0 ? status.mappings.map((row) => ({ ...row }))
      : (status.id === "claude" ? ["Sonnet", "Opus", "Haiku"] : [""]).map((displayName) => ({ displayName, modelId: "" }));
    baseline = JSON.stringify(drafts);
  }
  function setRow(index: number, key: keyof AgentMapping, value: string): void {
    drafts = drafts.map((row, i) => i === index ? { ...row, [key]: value } : row);
    notice = "";
  }
  async function mutate(restore: boolean): Promise<void> {
    if (restore) {
      if (!window.confirm(`Restore ${title}? This restores the configuration saved before the first apply, undoing all subsequent Gateway configuration changes.`)) return;
    } else if (!status.backupAvailable && !window.confirm(`Apply ${title} configuration? Gateway will privately back up the original global configuration before making changes. Restart the client after applying.`)) return;
    busy = true;
    failure = "";
    notice = "";
    try {
      const next = restore
        ? await client.restoreAgent({ agent: status.id, expectedRevision: status.revision })
        : await client.applyAgent({ agent: status.id, expectedRevision: status.revision, catalogRevision: catalogRevision!, mappings: drafts });
      status = next;
      resetDrafts();
      loadedRevision = next.revision;
      onchanged(next);
      notice = restore ? "Original configuration restored. Restart the client." : "Configuration installed. Restart the client; inference has not been tested.";
    } catch (error: unknown) {
      failure = errorMessage(error);
    } finally { busy = false; }
  }
</script>

<section class="agent-card" aria-label={title} aria-busy={busy}>
  <header class="agent-card-head">
    <h2>{title}</h2>
    <span class="badge">{stateLabel}</span>
  </header>
  {#if failure}<p class="notice error" role="alert">{failure}</p>{/if}
  {#if notice}<p class="notice success" role="status">{notice}</p>{/if}
  {#if status.state === "conflict" || status.state === "recovery_required"}
    <p class="notice">Outside edits are never overwritten. Refresh to inspect again. Restore is available only when recovery is unambiguous; otherwise keep recovery files and reconcile the external changes first.</p>
  {/if}
  <form onsubmit={(event) => { event.preventDefault(); void mutate(false); }}>
    <fieldset disabled={busy}>
      <legend>Model mapping</legend>
      <p class="muted" id={`${status.id}-mapping-help`}>The first row is the startup model. Display names are labels; Copilot model IDs are sent unchanged.</p>
      {#each drafts as row, index (index)}
        {#if index < 3 || status.id === "codex"}
          <div class="agent-mapping-row">
            {#if status.id === "claude"}<strong class="agent-role">{["Sonnet", "Opus", "Haiku"][index]}</strong>{/if}
            <label>Display name
              <input type="text" value={row.displayName} maxlength="80" required aria-describedby={`${status.id}-mapping-help`}
                oninput={(event) => setRow(index, "displayName", event.currentTarget.value)} />
            </label>
            <label>Copilot model ID
              <input type="text" value={row.modelId} maxlength="128" required spellcheck="false" autocomplete="off"
                oninput={(event) => setRow(index, "modelId", event.currentTarget.value)} />
            </label>
            {#if status.id === "codex"}
              <button type="button" aria-label={`Remove model ${index + 1}`} disabled={drafts.length === 1} onclick={() => drafts = drafts.filter((_, i) => i !== index)}>Remove</button>
            {/if}
          </div>
        {/if}
      {/each}
      {#if status.id === "codex"}
        <button type="button" disabled={drafts.length >= 16} onclick={() => drafts = [...drafts, { displayName: "", modelId: "" }]}>Add model</button>
      {:else}
        <details>
          <summary>Additional settings</summary>
          {#if drafts[3]}
            <div class="agent-mapping-row">
              <strong class="agent-role">Subagent</strong>
              <label>Display name<input type="text" value={drafts[3].displayName} maxlength="80" required oninput={(event) => setRow(3, "displayName", event.currentTarget.value)} /></label>
              <label>Copilot model ID<input type="text" value={drafts[3].modelId} maxlength="128" required oninput={(event) => setRow(3, "modelId", event.currentTarget.value)} /></label>
              <button type="button" onclick={() => drafts = drafts.slice(0, 3)}>Remove subagent mapping</button>
            </div>
          {:else}
            <button type="button" onclick={() => drafts = [...drafts, { displayName: "Subagent", modelId: "" }]}>Add subagent mapping</button>
          {/if}
        </details>
      {/if}
    </fieldset>
    <div class="agent-actions">
      <p aria-live="polite">{dirty ? "Unapplied changes" : "No unapplied changes"}</p>
      <button class="primary" disabled={busy || !dirty || !valid || !applyAllowed || catalogRevision === null}>Apply changes</button>
      <button type="button" disabled={busy || !status.canRestore} onclick={() => void mutate(true)}>Restore</button>
    </div>
  </form>
  <details class="agent-details">
    <summary>Configuration details</summary>
    <dl>
      <dt>Configuration paths</dt><dd>{#each status.paths as target (target)}<code>{target}</code>{/each}</dd>
      <dt>Trusted Gateway URL</dt><dd><code>{status.endpoint}</code></dd>
      <dt>Original backup</dt><dd>{status.backupAvailable ? "Available — retained from the first apply" : "Not created"}</dd>
      <dt>Last apply</dt><dd>{status.lastAppliedAt === null ? "Never" : new Date(status.lastAppliedAt).toLocaleString()}</dd>
    </dl>
  </details>
</section>
