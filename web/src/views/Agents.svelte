<script lang="ts">
  import { onMount } from "svelte";
  import { errorMessage, type AdminClient } from "../api.js";
  import type { AgentsView, AgentStatus } from "../../../src/agents/types.js";
  import type { AdminAgentModels } from "../../../src/admin/api.js";
  import AgentCard from "./AgentCard.svelte";

  let {
    client,
    pageNumber,
    data,
    catalog,
    onload,
    onloadmodels,
    onchanged,
  }: {
    client: AdminClient;
    pageNumber: string;
    data: AgentsView | null;
    catalog: AdminAgentModels | null;
    onload: (refresh?: boolean) => Promise<AgentsView>;
    onloadmodels: (refresh?: boolean) => Promise<AdminAgentModels>;
    onchanged: (status: AgentStatus) => void;
  } = $props();
  let loading = $state(false);
  let failure = $state("");
  let modelsLoading = $state(false);
  let modelsFailure = $state("");
  let disposed = false;
  const orderedItems = $derived(data?.items.toSorted((left, right) =>
    (left.id === "codex" ? 0 : 1) - (right.id === "codex" ? 0 : 1)) ?? []);

  onMount(() => {
    if (data === null) void load(false);
    if (catalog === null) void loadModels(false);
    return () => { disposed = true; };
  });

  async function load(refresh: boolean): Promise<void> {
    loading = true;
    failure = "";
    try {
      await onload(refresh);
    } catch (error: unknown) {
      if (!disposed && !(error instanceof DOMException && error.name === "AbortError")) failure = errorMessage(error);
    } finally {
      if (!disposed) loading = false;
    }
  }

  async function loadModels(refresh: boolean): Promise<void> {
    modelsLoading = true;
    modelsFailure = "";
    try {
      await onloadmodels(refresh);
    } catch (error: unknown) {
      if (!disposed && !(error instanceof DOMException && error.name === "AbortError")) modelsFailure = errorMessage(error);
    } finally {
      if (!disposed) modelsLoading = false;
    }
  }

  function refresh(): void {
    void load(true);
    void loadModels(true);
  }
</script>

<header class="page-head">
  <div>
    <p class="eyebrow">[{pageNumber}] LOCAL ADMINISTRATION</p>
    <h1 tabindex="-1">Agents</h1>
    <p>Configure global client model mappings for this Gateway process user.</p>
  </div>
  <button class="primary" disabled={loading || modelsLoading} onclick={refresh}>Refresh</button>
</header>
{#if failure}<p class="notice error" role="alert">{failure}</p>{/if}
{#if data}
  {#if modelsFailure}<p class="notice error" role="alert">{modelsFailure}</p>{/if}
  {#if modelsLoading}<p class="loading-line" role="status">Loading model choices...</p>
  {:else if catalog === null}<p class="notice" role="status">Model catalog unavailable. Sign in if needed, then refresh. Local configuration inspection does not require a Copilot account.</p>{/if}
  <div class="agent-cards">
    {#each orderedItems as status (status.id)}
      <AgentCard {client} {status} {catalog} {onchanged} />
    {/each}
  </div>
{:else if loading}<p class="loading-line" aria-busy="true">Reading agent configuration...</p>{/if}
