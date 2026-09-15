<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, errorMessage, type AdminClient } from "../api.js";
  import type { AdminAccounts, AdminModels } from "../types.js";

  type ModelItem = AdminModels["items"][number];

  let { client, pageNumber }: { client: AdminClient; pageNumber: string } = $props();
  let accounts: AdminAccounts | null = $state(null);
  let data: AdminModels | null = $state(null);
  let accountId = $state("");
  let loading = $state(true);
  let busy = $state("");
  let failure = $state("");
  let message = $state("");
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
    } catch (error: unknown) {
      if (!isCurrentRequest(generation, targetAccountId)) return;
      failure = errorMessage(error);
    } finally {
      if (isCurrentRequest(generation, targetAccountId)) loading = false;
    }
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

  function isCurrentRequest(generation: number, targetAccountId: string): boolean {
    return requestGeneration === generation && accountId === targetAccountId;
  }

  function sourceLabel(source: ModelItem["defaultOutputTokens"]["source"]): string {
    switch (source) {
      case "live": return "Upstream";
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
    <p>Inspect the account catalog and native interface metadata.</p>
  </div>
  <button class="primary" onclick={refresh} disabled={!accountId || busy === "refresh"}>
    {busy === "refresh" ? "Refreshing..." : "Refresh"}
  </button>
</header>

<section class="toolbar account-toolbar">
  <label for="model-account">Account</label>
  <select id="model-account" bind:value={accountId} onchange={() => void load()}>
    {#each accounts?.items.filter((account) => account.state === "active") ?? [] as account (account.accountId)}
      <option value={account.accountId}>{account.login ?? account.host} · {account.host}</option>
    {/each}
  </select>
  {#if data && data.accountId === accountId}
    <span class="subtle" title="Catalog cache version, account credential version and last successful catalog fetch time.">
      Generation {data.catalogGeneration} · credential {data.credentialGeneration} · fetched {new Date(data.fetchedAt).toLocaleString()}
    </span>
  {/if}
</section>

{#if message}<p class="notice success" role="status">{message}</p>{/if}
{#if failure}<p class="notice error" role="alert">{failure}</p>{/if}

{#if data?.preferredModel?.validity === "invalid"}
  <section class="notice warning" role="alert">
    <h2>Preferred model unavailable</h2>
    <p>Select a discovered model below. The gateway will not silently substitute one.</p>
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
    <p>The account returned no visible models. Refresh discovery to check again.</p>
  </section>
{:else if data}
  <section class="section" aria-labelledby="model-directory-title">
    <div class="section-heading">
      <h2 id="model-directory-title"><span class="section-number">[01]</span>Model directory</h2>
      <span class="badge">{data.items.length} models</span>
    </div>
    <details class="catalog-help" id="model-catalog-help">
      <summary>About sources and token limits</summary>
      <p>Only models discovered in the upstream catalog are listed.</p>
      <p>Protocols identifies the source of native interface metadata: Upstream, Built-in, or Unknown.
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
                  <button
                    class:primary={!preferred}
                    onclick={() => prefer(model.id)}
                    disabled={busy === `prefer:${model.id}` || preferred}
                  >{preferred ? "Preferred" : "Set preferred"}</button>
                </div>
              </td>
            </tr>
            <tr class="model-details-row">
              <td colspan="5">
                <details class="model-details">
                  <summary>Capability details</summary>
                  <div class="capability-grid">
                    <dl>
                      <div><dt>Native HTTP protocols</dt><dd>{model.protocols?.join(", ") || (model.protocols === null ? "Unknown" : "None")}</dd></div>
                      <div><dt>Protocol metadata source</dt><dd>{sourceLabel(model.protocolsSource)}{model.protocolsConflict ? " · Conflict" : ""} · Upstream declaration: {declarationLabel(model.protocolsLiveState)}</dd></div>
                      <div><dt>Max input tokens per request</dt><dd>{model.maxInputTokens?.toLocaleString() ?? "Unknown"} · {sourceLabel(model.maxInputTokensSource)}{model.maxInputTokensConflict ? " · Conflict" : ""} · Upstream declaration: {declarationLabel(model.maxInputTokensLiveState)}</dd></div>
                      <div><dt>Max output tokens per request</dt><dd>{model.maxOutputTokens?.toLocaleString() ?? "Unknown"} · {sourceLabel(model.maxOutputTokensSource)}{model.maxOutputTokensConflict ? " · Conflict" : ""} · Upstream declaration: {declarationLabel(model.maxOutputTokensLiveState)}</dd></div>
                      <div><dt>Default output</dt><dd>{model.defaultOutputTokens.effective.toLocaleString()} · {sourceLabel(model.defaultOutputTokens.source)}{model.defaultOutputTokens.conflict ? " · Conflict" : ""}{model.defaultOutputTokens.valid ? "" : " · Invalid for current ceiling"} · Upstream declaration: {declarationLabel(model.defaultOutputTokens.liveState)}</dd></div>
                      <div><dt>Chat budget field</dt><dd>{model.chatOutputTokenField ?? "Unknown"} · {sourceLabel(model.chatOutputTokenFieldSource)}{model.chatOutputTokenFieldConflict ? " · Conflict" : ""} · Upstream declaration: {declarationLabel(model.chatOutputTokenFieldLiveState)}</dd></div>
                      <div><dt>Built-in revision</dt><dd>{model.builtinRevision ?? "None"}</dd></div>
                    </dl>
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
  .account-toolbar { align-items: center; }
  .account-toolbar label { margin-bottom: 0; }
  .account-toolbar select { width: 280px; max-width: 100%; }

  .catalog-help {
    margin-bottom: 16px;
    color: var(--muted);
    font-size: 14px;
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
</style>
