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

  let { client }: { client: AdminClient } = $props();
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
    try {
      const refreshed = await client.refreshModels(targetAccountId);
      if (!isCurrentRequest(generation, targetAccountId)) return;
      data = refreshed;
      syncEditors();
      message = data.preferredModel?.validity === "invalid"
        ? "Catalog refreshed. Your previous preference is no longer available."
        : "Catalog refreshed.";
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
</script>

<header class="page-head">
  <div>
    <p class="eyebrow">[03] LOCAL ADMINISTRATION</p>
    <h1 tabindex="-1">Models</h1>
    <p>Inspect real capability provenance and explicitly configure each account's catalog.</p>
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
  <section class="toolbar" aria-label="Add configured model">
    <label for="configured-model-id">Model ID</label>
    <input id="configured-model-id" bind:value={newModelId} maxlength="128" placeholder="exact-model-id" />
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
    <div class="table-scroll">
      <table class="model-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Native interfaces</th>
            <th>Source</th>
            <th>Limits</th>
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
                  <span>{model.discovered ? "Discovered" : "Configured / unverified"}</span>
                  <small class="muted">{model.protocolsSource}{model.protocolsConflict ? " · conflict" : ""}</small>
                </div>
              </td>
              <td>
                <span>{model.maxInputTokens?.toLocaleString() ?? "Unknown"} in</span><br />
                <span>{model.maxOutputTokens?.toLocaleString() ?? "Unknown"} out</span>
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
                      <div><dt>Catalog state</dt><dd>{model.discovered ? "Discovered" : "Configured / unverified"} · {model.enabled ? "enabled" : "disabled"} · override revision {model.overrideRevision}</dd></div>
                      <div><dt>Native HTTP protocols</dt><dd>{model.protocols?.join(", ") || (model.protocols === null ? "Unknown" : "None")}</dd></div>
                      <div><dt>Protocol provenance</dt><dd>{model.protocolsSource}{model.protocolsConflict ? " · conflict" : ""} · live {model.protocolsLiveState}</dd></div>
                      <div><dt>Input window</dt><dd>{model.maxInputTokens?.toLocaleString() ?? "Unknown"} · {model.maxInputTokensSource}{model.maxInputTokensConflict ? " · conflict" : ""} · live {model.maxInputTokensLiveState}</dd></div>
                      <div><dt>Output window</dt><dd>{model.maxOutputTokens?.toLocaleString() ?? "Unknown"} · {model.maxOutputTokensSource}{model.maxOutputTokensConflict ? " · conflict" : ""} · live {model.maxOutputTokensLiveState}</dd></div>
                      <div><dt>Default output</dt><dd>{model.defaultOutputTokens.effective.toLocaleString()} · {model.defaultOutputTokens.source}{model.defaultOutputTokens.conflict ? " · conflict" : ""}{model.defaultOutputTokens.valid ? "" : " · invalid for current ceiling"} · live {model.defaultOutputTokens.liveState}</dd></div>
                      <div><dt>Chat budget field</dt><dd>{model.chatOutputTokenField ?? "Unknown"} · {model.chatOutputTokenFieldSource}{model.chatOutputTokenFieldConflict ? " · conflict" : ""} · live {model.chatOutputTokenFieldLiveState}</dd></div>
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
                            placeholder="use live/builtin"
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
                            placeholder="use live/builtin"
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
                            placeholder="automatic policy"
                          />
                        </label>
                        <label for={`chat-field-${index}`}>
                          Chat output token field
                          <select id={`chat-field-${index}`} bind:value={editor.chatOutputTokenField}>
                            <option value="">Use live/builtin/unknown</option>
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
