<script lang="ts">
  import { errorMessage, type AdminClient } from "../api.js";
  import { MAX_MAPPINGS, validateMappings, type AgentMapping, type AgentStatus } from "../../../src/agents/types.js";
  import type { AdminAgentModels } from "../../../src/admin/api.js";

  let { client, status, catalog, onchanged }: {
    client: AdminClient; status: AgentStatus; catalog: AdminAgentModels | null; onchanged: (status: AgentStatus) => void;
  } = $props();
  const title = $derived(status.id === "claude" ? "Claude Code" : "Codex");
  let drafts: AgentMapping[] = $state([]);
  let baseline = $state("");
  let loadedRevision = $state("");
  let busy = $state(false);
  let failure = $state("");
  let notice = $state("");
  const dirty = $derived(JSON.stringify(drafts) !== baseline);
  const stateLabel = $derived({
    not_managed: "Not managed", installed: "Configuration installed", conflict: "External changes detected",
    recovery_required: "Recovery required", unsafe_path: "Unsupported or unsafe path",
  }[status.state]);

  $effect(() => {
    if (loadedRevision !== status.revision) {
      if (loadedRevision !== "") {
        failure = "";
        notice = "";
      }
      if (loadedRevision === "" || !dirty) resetDrafts();
      loadedRevision = status.revision;
    } else if (status.state !== "installed") {
      notice = "";
    }
  });
  function resetDrafts(): void {
    drafts = status.mappings.length > 0 ? status.mappings.map((row) => ({ ...row }))
      : (status.id === "claude" ? ["Sonnet", "Opus", "Haiku"] : [""]).map((displayName) => ({ displayName, modelId: "" }));
    baseline = JSON.stringify(drafts);
  }
  function mappingName(index: number): string {
    if (status.id === "codex") return `Model ${index + 1}`;
    return ["Sonnet", "Opus", "Haiku"][index] ?? `Model ${index + 1}`;
  }
  function setRow(index: number, key: keyof AgentMapping, value: string): void {
    const selected = key === "modelId" ? catalog?.items.find((model) => model.id === value) : undefined;
    drafts = drafts.map((row, i) => i === index
      ? { ...row, [key]: value, ...(selected === undefined ? {} : { displayName: selected.name }) } : row);
    notice = "";
  }
  async function apply(): Promise<void> {
    if (busy) return;
    failure = "";
    notice = "";
    try {
      validateMappings(status.id, drafts);
    } catch {
      failure = "Enter a valid model ID and display name for each row. Extra models must not duplicate an earlier model.";
      return;
    }
    const selectedCatalog = catalog;
    if (selectedCatalog === null) {
      failure = "Model catalog is not ready. Sign in if needed, then refresh and try again.";
      return;
    }
    if (drafts.some((row) => !selectedCatalog.usableModelIds.includes(row.modelId))) {
      failure = "Choose discovered Copilot models with usable capabilities from the model list.";
      return;
    }
    if (status.state === "not_managed" && !window.confirm(`Apply ${title} configuration? The first original configuration will be retained in a private .ghcg.bak file when it exists. Later applies preserve that backup and update only Gateway-owned settings. Restart the client after applying.`)) return;
    busy = true;
    try {
      const next = await client.applyAgent({
        agent: status.id, expectedRevision: status.revision,
        catalogRevision: selectedCatalog.catalogRevision, mappings: drafts,
      });
      status = next;
      resetDrafts();
      loadedRevision = next.revision;
      onchanged(next);
      if (next.state === "installed") {
        notice = "Configuration installed. Restart the client; inference has not been tested.";
      } else {
        failure = {
          not_managed: "Configuration was not installed.",
          conflict: "Configuration was not installed because external changes were detected.",
          recovery_required: "Configuration was not installed because recovery is required.",
          unsafe_path: "Configuration was not installed because a path is unsupported or unsafe.",
        }[next.state];
      }
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
  {#if status.state === "recovery_required"}
    <p class="notice">An interrupted write may need recovery. Refresh and apply again; retain backup and recovery files if the operation reports a conflict.</p>
  {/if}
  <form novalidate onsubmit={(event) => { event.preventDefault(); void apply(); }}>
    <fieldset disabled={busy}>
      <legend>Model mapping</legend>
      <p class="muted" id={`${status.id}-mapping-help`}>{status.id === "claude" ? "Rows are ordered Sonnet, Opus, Haiku. " : ""}The first row is the startup model. Display names are labels; Copilot model IDs are sent unchanged.</p>
      {#if status.id === "claude"}<p class="muted">Additional rows appear in the model menu. Requires Claude Code 2.1.243 or newer.</p>{/if}
      <datalist id={`${status.id}-model-options`}>
        {#each catalog?.items ?? [] as model, index (`${model.id}:${index}`)}
          <option value={model.id} label={model.name}></option>
        {/each}
      </datalist>
      {#each drafts as row, index (index)}
          <div class="agent-mapping-row">
            <label><span><span class="visually-hidden">{mappingName(index)} </span>Copilot model ID</span>
              <input type="text" value={row.modelId} maxlength="128" required spellcheck="false" autocomplete="off"
                list={`${status.id}-model-options`} aria-describedby={`${status.id}-mapping-help`}
                oninput={(event) => setRow(index, "modelId", event.currentTarget.value)} />
            </label>
            <label><span><span class="visually-hidden">{mappingName(index)} </span>Display name</span>
              <input type="text" value={row.displayName} maxlength="80" required aria-describedby={`${status.id}-mapping-help`}
                oninput={(event) => setRow(index, "displayName", event.currentTarget.value)} />
            </label>
            {#if status.id === "codex" || index >= 3}
              <button type="button" aria-label={`Remove model ${index + 1}`} disabled={drafts.length === 1} onclick={() => drafts = drafts.filter((_, i) => i !== index)}>Remove</button>
            {/if}
          </div>
      {/each}
      <button type="button" disabled={drafts.length >= MAX_MAPPINGS} onclick={() => drafts = [...drafts, { displayName: "", modelId: "" }]}>Add model</button>
    </fieldset>
    <div class="agent-actions">
      <p aria-live="polite">{dirty ? "Unapplied changes" : ""}</p>
      <button class="primary" type="submit" disabled={busy}>Apply changes</button>
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
