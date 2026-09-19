<script lang="ts">
  import { onMount } from "svelte";
  import { errorMessage, type AdminClient } from "../api.js";
  import type { AdminAccounts, AdminModels } from "../types.js";

  let { client, pageNumber, onchanged }: { client: AdminClient; pageNumber: string; onchanged?: () => void } = $props();
  let accounts: AdminAccounts | null = $state(null);
  let data = $state<AdminModels | null>(null);
  let accountId = $state("");
  let loading = $state(true);
  let busy = $state("");
  let failure = $state("");
  let requestGeneration = 0;
  let disposed = false;
  const requests = new AbortController();
  const selectedData = $derived.by(() => data?.accountId === accountId ? data : null);

  onMount(() => {
    void initialize();
    return () => {
      disposed = true;
      requestGeneration += 1;
      requests.abort();
    };
  });

  async function initialize(): Promise<void> {
    try {
      const loaded = await client.accounts(requests.signal);
      if (disposed) return;
      accounts = loaded;
      accountId = accounts.defaultAccountId
        ?? accounts.items.find((account) => account.state === "active")?.accountId
        ?? "";
      await load();
    } catch (error: unknown) {
      if (disposed) return;
      failure = errorMessage(error);
      loading = false;
    }
  }

  async function load(): Promise<void> {
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
    failure = "";
    try {
      const loaded = await client.models(targetAccountId, requests.signal);
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
    onchanged?.();
    try {
      const refreshed = await client.refreshModels(targetAccountId, requests.signal);
      if (!isCurrentRequest(generation, targetAccountId)) return;
      data = refreshed;
    } catch (error: unknown) {
      if (!isCurrentRequest(generation, targetAccountId)) return;
      failure = errorMessage(error);
    } finally {
      if (isCurrentRequest(generation, targetAccountId)) busy = "";
    }
  }

  function isCurrentRequest(generation: number, targetAccountId: string): boolean {
    return !disposed && requestGeneration === generation && accountId === targetAccountId;
  }

  function supportLabel(supported: boolean): string {
    return supported ? "Supported" : "Not supported";
  }
</script>

<header class="page-head">
  <div>
    <p class="eyebrow">[{pageNumber}] LOCAL ADMINISTRATION</p>
    <h1 tabindex="-1">Models</h1>
    <p>Inspect the account catalog and declared model capabilities.</p>
  </div>
  <button class="primary" onclick={refresh} disabled={!accountId || loading || busy === "refresh"}>
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
  {#if selectedData}
    <span class="subtle" title="Catalog cache version, account credential version and last successful catalog fetch time.">
      Generation {selectedData.catalogGeneration} · credential {selectedData.credentialGeneration} · fetched {new Date(selectedData.fetchedAt).toLocaleString()}
    </span>
  {/if}
</section>

{#if failure}<p class="notice error" role="alert">{failure}</p>{/if}

{#if selectedData?.preferredModel?.validity === "invalid"}
  <section class="notice warning" role="alert">
    <h2>Preferred model unavailable</h2>
    <p>Use <code>ghcg models set &lt;model-id&gt;</code> to select a preferred model. The gateway will not silently substitute one.</p>
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
{:else if selectedData?.items.length === 0}
  <section class="empty">
    <span>00</span>
    <h2>Catalog is empty</h2>
    <p>The account returned no visible models. Refresh discovery to check again.</p>
  </section>
{:else if selectedData}
  <section class="section" aria-labelledby="model-directory-title">
    <div class="section-heading">
      <h2 id="model-directory-title"><span class="section-number">[01]</span>Model directory</h2>
      <span class="badge">{selectedData.items.length} models</span>
    </div>
    <details class="catalog-help" id="model-catalog-help">
      <summary>About model capabilities and token limits</summary>
      <p>Only models discovered in the account catalog are listed.</p>
      <p>Capabilities are catalog declarations used by the Gateway, not live inference validation or proof of account entitlement.</p>
      <p>Token limits apply to each request, not account quota. The input limit may be lower than the model's full context window.</p>
    </details>
    <div class="table-scroll">
      <table class="model-table" aria-describedby="model-catalog-help">
        <thead>
          <tr>
            <th>Model</th>
            <th>Native interfaces</th>
            <th>Per-request token limits</th>
          </tr>
        </thead>
        {#each selectedData.items as model, index (`${model.id}:${index}`)}
          <tbody data-model-id={model.id}>
            <tr>
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
                <div class="model-limits">
                  <span>Max input: {model.maxInputTokens?.toLocaleString() ?? "Unknown"}</span>
                  <span>Max output: {model.maxOutputTokens?.toLocaleString() ?? "Unknown"}</span>
                </div>
              </td>
            </tr>
            <tr class="model-details-row">
              <td colspan="3">
                <details class="model-details">
                  <summary>Model capabilities</summary>
                  <div class="capability-grid">
                    <dl>
                      <div><dt>Context window</dt><dd>{model.capabilities.contextWindowTokens?.toLocaleString() ?? "Unavailable"}</dd></div>
                      <div><dt>Maximum context window</dt><dd>{model.capabilities.maxContextWindowTokens?.toLocaleString() ?? "Unavailable"}</dd></div>
                      <div><dt>Reasoning levels</dt><dd>{model.capabilities.reasoningLevels.join(", ") || "Unavailable"}</dd></div>
                      <div><dt>Input modalities</dt><dd>{model.capabilities.inputModalities.join(", ")}</dd></div>
                      <div><dt>Tool calling</dt><dd>{supportLabel(model.capabilities.toolCalling)}</dd></div>
                      <div><dt>Parallel tool calling</dt><dd>{supportLabel(model.capabilities.parallelToolCalling)}</dd></div>
                      <div><dt>Reasoning summaries</dt><dd>{supportLabel(model.capabilities.reasoningSummaries)}</dd></div>
                      <div><dt>Verbosity</dt><dd>{supportLabel(model.capabilities.verbosity)}</dd></div>
                      <div><dt>Search</dt><dd>{supportLabel(model.capabilities.search)}</dd></div>
                      <div><dt>Native HTTP protocols</dt><dd>{model.protocols?.join(", ") || (model.protocols === null ? "Unknown" : "None")}</dd></div>
                      <div><dt>Maximum input tokens per request</dt><dd>{model.maxInputTokens?.toLocaleString() ?? "Unavailable"}</dd></div>
                      <div><dt>Maximum output tokens per request</dt><dd>{model.maxOutputTokens?.toLocaleString() ?? "Unavailable"}</dd></div>
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

  .catalog-help[open] summary {
    margin-bottom: 8px;
  }

  .catalog-help p {
    margin-bottom: 6px;
  }


  .model-limits {
    display: grid;
    gap: 4px;
    white-space: nowrap;
  }
</style>
