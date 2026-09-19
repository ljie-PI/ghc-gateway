<script lang="ts">
  import { agentApplyErrorMessage, type AdminClient } from "../api.js";
  import { MAX_MAPPINGS, validateMappings, type AgentMapping, type AgentStatus } from "../../../src/agents/types.js";
  import type { AdminAgentModels } from "../../../src/admin/api.js";
  import AgentModelCombobox from "./AgentModelCombobox.svelte";

  type DraftRow = AgentMapping & { readonly key: number };

  let { client, status, catalog, modelsLoading, modelsUnavailable, onchanged }: {
    client: AdminClient;
    status: AgentStatus;
    catalog: AdminAgentModels | null;
    modelsLoading: boolean;
    modelsUnavailable: boolean;
    onchanged: (status: AgentStatus) => void;
  } = $props();
  const title = $derived(status.id === "claude" ? "Claude Code" : "Codex");
  let drafts: DraftRow[] = $state([]);
  let nextRowKey = 0;
  let baseline = $state("");
  let loadedRevision = $state("");
  let busy = $state(false);
  let failure = $state("");
  let notice = $state("");
  let takeoverDialog = $state<HTMLDialogElement>();
  const dirty = $derived(serializedDrafts() !== baseline);
  const stateLabel = $derived({
    not_managed: "Not managed", installed: "Configuration installed", conflict: "External changes detected",
    recovery_required: "Recovery required", unsafe_path: "Unsupported or unsafe path",
  }[status.state]);

  $effect(() => {
    if (loadedRevision !== status.revision) {
      if (loadedRevision !== "") {
        notice = "";
      }
      if (loadedRevision === "" || !dirty) resetDrafts();
      loadedRevision = status.revision;
    } else if (status.state !== "installed") {
      notice = "";
    }
  });
  function resetDrafts(): void {
    const mappings = status.mappings.length > 0 ? status.mappings
      : (status.id === "claude" ? ["Sonnet", "Opus", "Haiku"] : [""])
        .map((displayName) => ({ displayName, modelId: "" }));
    drafts = mappings.map((row) => ({ ...row, key: nextRowKey++ }));
    baseline = serializedDrafts();
  }
  function mappingName(index: number): string {
    if (status.id === "codex") return `Model ${index + 1}`;
    return ["Sonnet", "Opus", "Haiku"][index] ?? `Model ${index + 1}`;
  }
  function setRow(index: number, key: keyof AgentMapping, value: string): void {
    drafts = drafts.map((row, i) => i === index ? { ...row, [key]: value } : row);
    notice = "";
  }
  function selectModel(index: number, model: AdminAgentModels["items"][number]): void {
    drafts = drafts.map((row, i) => i === index
      ? { ...row, modelId: model.id, displayName: model.name } : row);
    notice = "";
  }
  function serializedDrafts(): string {
    return JSON.stringify(drafts.map(({ displayName, modelId }) => ({ displayName, modelId })));
  }
  async function apply(): Promise<void> {
    if (busy) return;
    notice = "";
    try {
      validateMappings(status.id, drafts);
    } catch {
      failure = "Apply failed: invalid model mapping.";
      return;
    }
    const selectedCatalog = catalog;
    if (selectedCatalog === null) {
      failure = "Apply failed: model catalog unavailable.";
      return;
    }
    if (drafts.some((row) => !selectedCatalog.usableModelIds.includes(row.modelId))) {
      failure = "Apply failed: selected model is unavailable.";
      return;
    }
    if (status.state === "not_managed" && !window.confirm(`Apply ${title} configuration? The first original configuration will be retained in a private .ghcg.bak file when it exists. Later applies preserve that backup and update only Gateway-owned settings. Restart the client after applying.`)) return;
    busy = true;
    try {
      const next = await client.applyAgent({
        agent: status.id, expectedRevision: status.revision,
        catalogRevision: selectedCatalog.catalogRevision,
        mappings: drafts.map(({ displayName, modelId }) => ({ displayName, modelId })),
      });
      status = next;
      loadedRevision = next.revision;
      onchanged(next);
      if (next.state === "installed") {
        failure = "";
        resetDrafts();
        loadedRevision = next.revision;
        notice = "Configuration installed. Restart the client; inference has not been tested.";
      } else {
        failure = {
          not_managed: "Apply failed: configuration was not installed.",
          conflict: "Apply failed: external changes detected.",
          recovery_required: "Apply failed: recovery required.",
          unsafe_path: "Apply failed: unsafe configuration path.",
        }[next.state];
      }
    } catch (error: unknown) {
      failure = agentApplyErrorMessage(error);
    } finally { busy = false; }
  }
  async function takeover(): Promise<void> {
    const offer = status.takeover;
    const selectedCatalog = catalog;
    if (busy || offer === null) return;
    if (selectedCatalog === null) {
      failure = "Apply failed: model catalog unavailable.";
      return;
    }
    try {
      validateMappings(status.id, drafts);
    } catch {
      failure = "Apply failed: invalid model mapping.";
      return;
    }
    if (drafts.some((row) => !selectedCatalog.usableModelIds.includes(row.modelId))) {
      failure = "Apply failed: selected model is unavailable.";
      return;
    }
    busy = true;
    notice = "";
    try {
      const next = await client.takeoverAgent({
        agent: status.id,
        expectedRevision: status.revision,
        catalogRevision: selectedCatalog.catalogRevision,
        takeoverRevision: offer.revision,
        mappings: drafts.map(({ displayName, modelId }) => ({ displayName, modelId })),
      });
      status = next;
      loadedRevision = next.revision;
      onchanged(next);
      if (next.state === "installed") {
        failure = "";
        resetDrafts();
        loadedRevision = next.revision;
        notice = "Configuration installed. Restart Codex; inference has not been tested.";
      } else failure = "Apply failed: configuration was not installed.";
    } catch (error: unknown) {
      failure = agentApplyErrorMessage(error);
    } finally { busy = false; }
  }
</script>

<section class="agent-card" aria-label={title} aria-busy={busy}>
  <header class="agent-card-head">
    <h2>{title}</h2>
    <span class="badge">{stateLabel}</span>
  </header>
  {#if notice}<p class="notice success" role="status">{notice}</p>{/if}
  {#if status.state === "recovery_required"}
    <p class="notice">An interrupted write may need recovery. Refresh and apply again; retain backup and recovery files if the operation reports a conflict.</p>
  {/if}
  <form novalidate onsubmit={(event) => { event.preventDefault(); void apply(); }}>
    <fieldset disabled={busy}>
      <legend>Model mapping</legend>
      <p class="muted" id={`${status.id}-mapping-help`}>{status.id === "claude" ? "Rows are ordered Sonnet, Opus, Haiku. " : ""}The first row is the startup model. Display names are labels; Copilot model IDs are sent unchanged.</p>
      {#if status.id === "claude"}<p class="muted">Additional rows appear in the model menu. Requires Claude Code 2.1.243 or newer.</p>{/if}
      {#each drafts as row, index (row.key)}
          <div class="agent-mapping-row">
            <label><span><span class="visually-hidden">{mappingName(index)} </span>Copilot model ID</span>
              <AgentModelCombobox
                id={`${status.id}-model-${row.key}`}
                label={`${mappingName(index)} Copilot model ID`}
                value={row.modelId}
                {catalog}
                loading={modelsLoading}
                unavailable={modelsUnavailable}
                describedby={`${status.id}-mapping-help`}
                oninput={(value) => setRow(index, "modelId", value)}
                onselect={(model) => selectModel(index, model)}
              />
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
      <button type="button" disabled={drafts.length >= MAX_MAPPINGS} onclick={() => drafts = [...drafts, { displayName: "", modelId: "", key: nextRowKey++ }]}>Add model</button>
    </fieldset>
    <div class="agent-actions">
      {#if failure}<p class="agent-apply-failure" role="alert">{failure}</p>{:else}<span></span>{/if}
      {#if status.id === "codex" && status.takeover !== null}
        <button type="button" disabled={busy} onclick={() => takeoverDialog?.showModal()}>Take over Codex configuration</button>
      {/if}
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
  {#if status.id === "codex" && status.takeover !== null}
    <dialog class="agent-takeover-dialog" bind:this={takeoverDialog} aria-labelledby="codex-takeover-title">
      <form method="dialog">
        <h3 id="codex-takeover-title">Take over Codex configuration?</h3>
        <p>Gateway-managed model, provider, and catalog fields will change. Unrelated TOML settings are preserved, <code>auth.json</code> is untouched, and Codex must restart.</p>
        <dl>
          <dt>Configuration</dt><dd><code>{status.takeover.configPath}</code></dd>
          <dt>Model catalog</dt><dd><code>{status.takeover.catalogPath}</code></dd>
          <dt>Configuration backup</dt><dd><code>{status.takeover.configBackupPath}</code></dd>
          <dt>Catalog backup</dt><dd><code>{status.takeover.catalogBackupPath}</code></dd>
        </dl>
        <div class="agent-dialog-actions">
          <button value="cancel">Cancel</button>
          <button class="primary" value="confirm" onclick={(event) => {
            event.preventDefault();
            takeoverDialog?.close();
            void takeover();
          }}>Take over configuration</button>
        </div>
      </form>
    </dialog>
  {/if}
</section>
