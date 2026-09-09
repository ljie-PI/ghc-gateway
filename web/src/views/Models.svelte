<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, errorMessage, type AdminClient } from "../api.js";
  import type { AdminAccounts, AdminModels } from "../types.js";

  type ModelItem = AdminModels["items"][number];
  type Protocol = NonNullable<ModelItem["protocols"]>[number];
  type Editor = {
    enabled: boolean;
    overrideProtocols: boolean;
    protocols: Protocol[];
    maxInputTokens: number | null;
    maxOutputTokens: number | null;
    defaultOutputTokens: number | null;
    chatOutputTokenField: "" | "max_tokens" | "max_completion_tokens";
  };

  let { client, pageNumber }: { client: AdminClient; pageNumber: string } = $props();
  let accounts: AdminAccounts | null = $state(null);
  let data: AdminModels | null = $state(null);
  let accountId = $state("");
  let loading = $state(true);
  let busy = $state("");
  let failure = $state("");
  let message = $state("");
  let editors = $state<Record<string, Editor>>({});
  let newModelId = $state("");
  let requestGeneration = 0;

  onMount(async () => {
    try {
      accounts = await client.accounts();
      accountId = accounts.defaultAccountId
        ?? accounts.items.find((account) => account.state === "active")?.accountId
        ?? "";
      await load();
    } catch (error: unknown) {
      failure = errorMessage(error);
      loading = false;
    }
  });

  async function load(preserveFailure = false): Promise<void> {
    if (!accountId) {
      requestGeneration += 1;
      loading = false;
      data = null;
      return;
    }
    const targetAccountId = accountId;
    const generation = ++requestGeneration;
    loading = true;
    busy = "";
    if (!preserveFailure) failure = "";
    try {
      const loaded = await client.models(targetAccountId);
      if (!isCurrentRequest(generation, targetAccountId)) return;
      data = loaded;
      syncEditors();
    } catch (error: unknown) {
      if (!isCurrentRequest(generation, targetAccountId)) return;
      failure = errorMessage(error);
    } finally {
      if (isCurrentRequest(generation, targetAccountId)) loading = false;
    }
  }

  function syncEditors(): void {
    const next: Record<string, Editor> = {};
    for (const model of data?.items ?? []) {
      const override = model.override;
      next[model.id] = {
        enabled: override?.enabled ?? model.enabled,
        overrideProtocols: override?.protocols !== undefined,
        protocols: [...(override?.protocols ?? model.protocols ?? [])],
        maxInputTokens: override?.maxInputTokens ?? null,
        maxOutputTokens: override?.maxOutputTokens ?? null,
        defaultOutputTokens: override?.defaultOutputTokens ?? null,
        chatOutputTokenField: override?.chatOutputTokenField ?? "",
      };
    }
    editors = next;
  }

  async function refresh(): Promise<void> {
    if (!accountId) return;
    const targetAccountId = accountId;
    const generation = ++requestGeneration;
    busy = "refresh";
    failure = "";
    message = "";
    try {
      const refreshed = await client.refreshModels(targetAccountId);
      if (!isCurrentRequest(generation, targetAccountId)) return;
      data = refreshed;
      syncEditors();
    } catch (error: unknown) {
      if (!isCurrentRequest(generation, targetAccountId)) return;
      failure = errorMessage(error);
    } finally {
      if (isCurrentRequest(generation, targetAccountId)) busy = "";
    }
  }

  async function prefer(id: string): Promise<void> {
    if (!data || data.accountId !== accountId) return;
    const targetAccountId = data.accountId;
    const generation = ++requestGeneration;
    busy = `prefer:${id}`;
    failure = "";
    try {
      await client.preferModel(targetAccountId, id, data.preferredModel?.revision ?? 0);
      if (!isCurrentRequest(generation, targetAccountId)) return;
      message = `${id} is now preferred.`;
      await load();
    } catch (error: unknown) {
      if (!isCurrentRequest(generation, targetAccountId)) return;
      failure = errorMessage(error);
      if (error instanceof ApiError && error.status === 409) await load(true);
    } finally {
      if (accountId === targetAccountId) busy = "";
    }
  }

  async function save(model: ModelItem): Promise<void> {
    const editor = editors[model.id];
    if (!data || data.accountId !== accountId || editor === undefined) return;
    const targetAccountId = data.accountId;
    const generation = ++requestGeneration;
    busy = `save:${model.id}`;
    failure = "";
    try {
      const saved = await client.setModelCapabilities(
        targetAccountId,
        model.id,
        model.overrideRevision,
        data.credentialGeneration,
        data.catalogGeneration,
        {
          enabled: editor.enabled,
          ...(editor.overrideProtocols ? { protocols: editor.protocols } : {}),
          ...optionalNumber("maxInputTokens", editor.maxInputTokens),
          ...optionalNumber("maxOutputTokens", editor.maxOutputTokens),
          ...optionalNumber("defaultOutputTokens", editor.defaultOutputTokens),
          ...(editor.chatOutputTokenField === "" ? {} : {
            chatOutputTokenField: editor.chatOutputTokenField,
          }),
        },
      );
      if (!isCurrentRequest(generation, targetAccountId)) return;
      data = saved;
      syncEditors();
      message = `${model.id} capability override saved.`;
    } catch (error: unknown) {
      if (!isCurrentRequest(generation, targetAccountId)) return;
      failure = errorMessage(error);
      if (error instanceof ApiError && error.status === 409) await load(true);
    } finally {
      if (isCurrentRequest(generation, targetAccountId)) busy = "";
    }
  }

  async function reset(model: ModelItem): Promise<void> {
    if (!data || data.accountId !== accountId) return;
    const targetAccountId = data.accountId;
    const generation = ++requestGeneration;
    busy = `reset:${model.id}`;
    failure = "";
    try {
      const resetData = await client.resetModelCapabilities(
        targetAccountId,
        model.id,
        model.overrideRevision,
        data.credentialGeneration,
        data.catalogGeneration,
      );
      if (!isCurrentRequest(generation, targetAccountId)) return;
      data = resetData;
      syncEditors();
      message = `${model.id} capability override reset.`;
    } catch (error: unknown) {
      if (!isCurrentRequest(generation, targetAccountId)) return;
      failure = errorMessage(error);
      if (error instanceof ApiError && error.status === 409) await load(true);
    } finally {
      if (isCurrentRequest(generation, targetAccountId)) busy = "";
    }
  }

  async function addConfiguredModel(): Promise<void> {
    if (!data || data.accountId !== accountId || !newModelId) return;
    const targetAccountId = data.accountId;
    const generation = ++requestGeneration;
    const modelId = newModelId;
    busy = "add";
    failure = "";
    try {
      const configured = await client.setModelCapabilities(
        targetAccountId,
        modelId,
        data.capabilityRevision,
        data.credentialGeneration,
        data.catalogGeneration,
        {
        enabled: true,
        protocols: [],
        },
      );
      if (!isCurrentRequest(generation, targetAccountId)) return;
      data = configured;
      message = `${modelId} added as configured and unverified.`;
      newModelId = "";
      syncEditors();
    } catch (error: unknown) {
      if (!isCurrentRequest(generation, targetAccountId)) return;
      failure = errorMessage(error);
    } finally {
      if (isCurrentRequest(generation, targetAccountId)) busy = "";
    }
  }

  function toggleProtocol(modelId: string, protocol: Protocol, checked: boolean): void {
    const editor = editors[modelId];
    if (editor === undefined) return;
    editor.protocols = checked
      ? [...new Set([...editor.protocols, protocol])]
      : editor.protocols.filter((value) => value !== protocol);
  }

  function optionalNumber<Key extends "maxInputTokens" | "maxOutputTokens" | "defaultOutputTokens">(
    key: Key,
    value: number | null | undefined,
  ): Partial<Record<Key, number>> {
    return value == null ? {} : { [key]: value } as Partial<Record<Key, number>>;
  }

  function isCurrentRequest(generation: number, targetAccountId: string): boolean {
    return requestGeneration === generation && accountId === targetAccountId;
  }

  function sourceLabel(source: ModelItem["defaultOutputTokens"]["source"]): string {
    switch (source) {
      case "live": return "Upstream";
      case "admin_override": return "Admin override";
      case "builtin": return "Built-in";
      case "known_ceiling": return "Known ceiling policy";
      case "unknown_fallback": return "Unknown ceiling fallback";
      default: return "Unknown";
    }
  }

  function declarationLabel(state: ModelItem["protocolsLiveState"]): string {
    switch (state) {
      case "value": return "Present";
      case "missing": return "Missing";
      case "malformed": return "Malformed";
      default: return "Unknown";
    }
  }
</script>

<header class="page-head">
  <div>
    <p class="eyebrow">[{pageNumber}] LOCAL ADMINISTRATION</p>
    <h1 tabindex="-1">Models</h1>
    <p>Inspect the account catalog and native interface metadata, or configure explicit overrides.</p>
  </div>
  <button class="primary" onclick={refresh} disabled={!accountId || busy === "refresh"}>
    {busy === "refresh" ? "Refreshing..." : "Refresh catalog"}
  </button>
</header>

<section class="toolbar">
  <label for="model-account">Account</label>
  <select id="model-account" bind:value={accountId} onchange={() => void load()}>
    {#each accounts?.items.filter((account) => account.state === "active") ?? [] as account (account.accountId)}
      <option value={account.accountId}>{account.login ?? account.host} · {account.host}</option>
    {/each}
  </select>
  {#if data}
    <span class="subtle">
      Generation {data.catalogGeneration} · credential {data.credentialGeneration} · fetched {new Date(data.fetchedAt).toLocaleString()}
    </span>
  {/if}
</section>

{#if data}
  <section class="toolbar configured-model-form" aria-label="Add configured model">
    <label for="configured-model-id">Model ID</label>
    <input
      id="configured-model-id"
      bind:value={newModelId}
      maxlength="128"
      placeholder="Exact model ID"
      autocapitalize="none"
      spellcheck={false}
    />
    <button onclick={addConfiguredModel} disabled={!newModelId || busy === "add"}>
      {busy === "add" ? "Adding..." : "Add configured model"}
    </button>
  </section>
{/if}

{#if message}<p class="notice success" role="status">{message}</p>{/if}
{#if failure}<p class="notice error" role="alert">{failure}</p>{/if}

{#if data?.preferredModel?.validity === "invalid"}
  <section class="notice warning" role="alert">
    <h2>Preferred model unavailable</h2>
    <p>Select an enabled visible model below. The gateway will not silently substitute one.</p>
  </section>
{/if}

{#if loading}
  <p class="loading-line" aria-busy="true">Loading model catalog...</p>
{:else if !accountId}
  <section class="empty">
    <span>--</span>
    <h2>No active account</h2>
    <p>Connect an account before requesting a model catalog.</p>
  </section>
{:else if data?.items.length === 0}
  <section class="empty">
    <span>00</span>
    <h2>Catalog is empty</h2>
    <p>The account returned no visible models. Add an exact model ID or refresh discovery.</p>
  </section>
{:else if data}
  <section class="section" aria-labelledby="model-directory-title">
    <div class="section-heading">
      <h2 id="model-directory-title"><span class="section-number">[01]</span>Model directory</h2>
      <span class="badge">{data.items.length} models</span>
    </div>
    <details class="catalog-help" id="model-catalog-help">
      <summary>About sources and token limits</summary>
      <p>Discovered means the model is in the upstream catalog; Configured means an Admin override exists.</p>
      <p>Protocols identifies the source of native interface metadata: Upstream, Admin override, Built-in, or Unknown.
        These are metadata, not live inference validation or proof of account entitlement.</p>
      <p>Token limits apply to each request, not account quota. The input limit may be lower than the model's full context window.</p>
    </details>
    <div class="table-scroll">
      <table class="model-table" aria-describedby="model-catalog-help">
        <thead>
          <tr>
            <th>Model</th>
            <th>Native interfaces</th>
            <th>Source</th>
            <th>Per-request token limits</th>
            <th>Preference</th>
          </tr>
        </thead>
        {#each data.items as model, index (`${model.id}:${index}`)}
          {@const editor = editors[model.id]}
          {@const preferred = data.preferredModel?.modelId === model.id && data.preferredModel.validity === "valid"}
          <tbody data-model-id={model.id}>
            <tr class:current-row={preferred}>
              <td>
                <div class="model-summary">
                  <strong>{model.name}</strong>
                  <code>{model.id}</code>
                  <small>{model.vendor}</small>
                </div>
              </td>
              <td>
                <div class="tag-group">
                  {#if model.protocols === null}
                    <span class="badge warning">Unknown</span>
                  {:else if model.protocols.length === 0}
                    <span class="badge">None</span>
                  {:else}
                    {#each model.protocols as protocol (protocol)}
                      <span class="badge">{protocol}</span>
                    {/each}
                  {/if}
                </div>
              </td>
              <td>
                <div class="model-source">
                  {#if model.discovered}<span class="badge">Discovered</span>{/if}
                  {#if model.configured}
                    <span class="badge" class:warning={!model.verified}>
                      {model.verified ? "Configured override" : "Configured / unverified"}
                    </span>
                  {/if}
                  <span class="badge">Protocols: {sourceLabel(model.protocolsSource)}</span>
                  {#if model.protocolsConflict}<span class="badge warning">Protocol conflict</span>{/if}
                </div>
              </td>
              <td>
                <div class="model-limits">
                  <span>Max input: {model.maxInputTokens?.toLocaleString() ?? "Unknown"}</span>
                  <span>Max output: {model.maxOutputTokens?.toLocaleString() ?? "Unknown"}</span>
                </div>
              </td>
              <td>
                <div class="row-actions">
                  {#if model.visible}
                    <button
                      class:primary={!preferred}
                      onclick={() => prefer(model.id)}
                      disabled={busy === `prefer:${model.id}` || preferred}
                    >{preferred ? "Preferred" : "Set preferred"}</button>
                  {:else}
                    <span class="badge">Hidden</span>
                  {/if}
                </div>
              </td>
            </tr>
            <tr class="model-editor-row">
              <td colspan="5">
                <details class="model-editor">
                  <summary>Capability details and override</summary>
                  <div class="capability-grid">
                    <dl>
                      <div>
                        <dt>Catalog state</dt>
                        <dd>
                          {model.discovered ? "Discovered" : "Not discovered"} ·
                          {model.configured
                            ? (model.verified ? "Configured override" : "Configured / unverified")
                            : "No Admin override"} ·
                          {model.enabled ? "enabled" : "disabled"} · override revision {model.overrideRevision}
                        </dd>
                      </div>
                      <div><dt>Native HTTP protocols</dt><dd>{model.protocols?.join(", ") || (model.protocols === null ? "Unknown" : "None")}</dd></div>
                      <div><dt>Protocol metadata source</dt><dd>{sourceLabel(model.protocolsSource)}{model.protocolsConflict ? " · Conflict" : ""} · Upstream declaration: {declarationLabel(model.protocolsLiveState)}</dd></div>
                      <div><dt>Max input tokens per request</dt><dd>{model.maxInputTokens?.toLocaleString() ?? "Unknown"} · {sourceLabel(model.maxInputTokensSource)}{model.maxInputTokensConflict ? " · Conflict" : ""} · Upstream declaration: {declarationLabel(model.maxInputTokensLiveState)}</dd></div>
                      <div><dt>Max output tokens per request</dt><dd>{model.maxOutputTokens?.toLocaleString() ?? "Unknown"} · {sourceLabel(model.maxOutputTokensSource)}{model.maxOutputTokensConflict ? " · Conflict" : ""} · Upstream declaration: {declarationLabel(model.maxOutputTokensLiveState)}</dd></div>
                      <div><dt>Default output</dt><dd>{model.defaultOutputTokens.effective.toLocaleString()} · {sourceLabel(model.defaultOutputTokens.source)}{model.defaultOutputTokens.conflict ? " · Conflict" : ""}{model.defaultOutputTokens.valid ? "" : " · Invalid for current ceiling"} · Upstream declaration: {declarationLabel(model.defaultOutputTokens.liveState)}</dd></div>
                      <div><dt>Chat budget field</dt><dd>{model.chatOutputTokenField ?? "Unknown"} · {sourceLabel(model.chatOutputTokenFieldSource)}{model.chatOutputTokenFieldConflict ? " · Conflict" : ""} · Upstream declaration: {declarationLabel(model.chatOutputTokenFieldLiveState)}</dd></div>
                      <div><dt>Built-in revision</dt><dd>{model.builtinRevision ?? "None"}</dd></div>
                    </dl>

                    {#if editor}
                      <fieldset
                        class="override-form"
                        aria-label={`${model.id} capability override`}
                        disabled={busy === `save:${model.id}` || busy === `reset:${model.id}`}
                      >
                        <label class="check">
                          <input type="checkbox" bind:checked={editor.enabled} />
                          Enabled and visible
                        </label>
                        <label class="check">
                          <input type="checkbox" bind:checked={editor.overrideProtocols} />
                          Override native protocols
                        </label>
                        <fieldset class="protocol-fieldset" disabled={!editor.overrideProtocols}>
                          <legend>Native HTTP protocols</legend>
                          {#each ["chat", "messages", "responses"] as protocol (protocol)}
                            <label>
                              <input
                                type="checkbox"
                                checked={editor.protocols.includes(protocol as Protocol)}
                                onchange={(event) => toggleProtocol(model.id, protocol as Protocol, event.currentTarget.checked)}
                              />
                              {protocol}
                            </label>
                          {/each}
                        </fieldset>
                        <label for={`input-limit-${index}`}>
                          Override input ceiling
                          <input
                            id={`input-limit-${index}`}
                            type="number"
                            min="1"
                            value={editor.maxInputTokens ?? ""}
                            oninput={(event) => { editor.maxInputTokens = event.currentTarget.value === "" ? null : event.currentTarget.valueAsNumber; }}
                            placeholder="Use upstream/built-in"
                          />
                        </label>
                        <label for={`output-limit-${index}`}>
                          Override output ceiling
                          <input
                            id={`output-limit-${index}`}
                            type="number"
                            min="1"
                            value={editor.maxOutputTokens ?? ""}
                            oninput={(event) => { editor.maxOutputTokens = event.currentTarget.value === "" ? null : event.currentTarget.valueAsNumber; }}
                            placeholder="Use upstream/built-in"
                          />
                        </label>
                        <label for={`default-output-${index}`}>
                          Default output tokens
                          <input
                            id={`default-output-${index}`}
                            type="number"
                            min="1"
                            value={editor.defaultOutputTokens ?? ""}
                            oninput={(event) => { editor.defaultOutputTokens = event.currentTarget.value === "" ? null : event.currentTarget.valueAsNumber; }}
                            placeholder="Automatic policy"
                          />
                        </label>
                        <label for={`chat-field-${index}`}>
                          Chat output token field
                          <select id={`chat-field-${index}`} bind:value={editor.chatOutputTokenField}>
                            <option value="">Use upstream/built-in/unknown</option>
                            <option value="max_tokens">max_tokens</option>
                            <option value="max_completion_tokens">max_completion_tokens</option>
                          </select>
                        </label>
                        <div class="model-actions">
                          <button class="primary" onclick={() => save(model)} disabled={busy === `save:${model.id}`}>
                            {busy === `save:${model.id}` ? "Saving..." : "Save capability override"}
                          </button>
                          {#if model.configured}
                            <button onclick={() => reset(model)} disabled={busy === `reset:${model.id}`}>
                              {busy === `reset:${model.id}` ? "Resetting..." : "Reset override"}
                            </button>
                          {/if}
                        </div>
                      </fieldset>
                    {/if}
                  </div>
                </details>
              </td>
            </tr>
          </tbody>
        {/each}
      </table>
    </div>
  </section>
{/if}

<style>
  .configured-model-form {
    display: grid;
    grid-template-columns: max-content minmax(0, 260px) max-content;
    align-items: center;
    justify-content: start;
  }

  .configured-model-form label {
    margin-bottom: 0;
  }

  .configured-model-form input,
  .configured-model-form button {
    min-height: 40px;
    padding: 8px 11px;
    line-height: 1.5;
  }

  .catalog-help {
    margin-bottom: 16px;
    color: var(--muted);
    font-size: 12px;
  }

  .catalog-help summary {
    cursor: pointer;
  }

  .catalog-help[open] summary {
    margin-bottom: 8px;
  }

  .catalog-help p {
    margin-bottom: 6px;
  }

  .model-source {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
  }

  .model-source .badge {
    flex-shrink: 0;
    text-transform: none;
  }

  .model-limits {
    display: grid;
    gap: 4px;
    white-space: nowrap;
  }

  @media (max-width: 600px) {
    .configured-model-form {
      grid-template-columns: minmax(0, 1fr);
      justify-content: stretch;
    }
  }
</style>
