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
    catalogGeneration,
    onload,
    onloadmodels,
    onobserveaccounts,
    onchanged,
  }: {
    client: AdminClient;
    pageNumber: string;
    data: AgentsView | null;
    catalog: AdminAgentModels | null;
    catalogGeneration: number;
    onload: (refresh?: boolean) => Promise<AgentsView>;
    onloadmodels: (refresh?: boolean) => Promise<AdminAgentModels>;
    onobserveaccounts: (signal: AbortSignal) => Promise<boolean>;
    onchanged: (status: AgentStatus) => void;
  } = $props();
  let loading = $state(false);
  let failure = $state("");
  let modelsLoading = $state(false);
  let modelsFailure = $state("");
  let disposed = false;
  let catalogTrackingInitialized = false;
  let attemptedCatalogGeneration = -1;
  let modelsLoadGeneration = 0;
  let accountObservationTimer: ReturnType<typeof setTimeout> | null = null;
  const accountObservation = new AbortController();
  const orderedItems = $derived(data?.items.toSorted((left, right) =>
    (left.id === "codex" ? 0 : 1) - (right.id === "codex" ? 0 : 1)) ?? []);

  onMount(() => {
    if (data === null) void load(false);
    void observeAccounts();
    return () => {
      disposed = true;
      if (accountObservationTimer !== null) clearTimeout(accountObservationTimer);
      accountObservation.abort();
    };
  });

  $effect(() => {
    if (!catalogTrackingInitialized) {
      catalogTrackingInitialized = true;
      attemptedCatalogGeneration = catalogGeneration;
    } else if (catalog === null && attemptedCatalogGeneration !== catalogGeneration) {
      attemptedCatalogGeneration = catalogGeneration;
      void loadModels(false);
    }
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
    const generation = ++modelsLoadGeneration;
    modelsLoading = true;
    modelsFailure = "";
    try {
      await onloadmodels(refresh);
    } catch (error: unknown) {
      if (!disposed && generation === modelsLoadGeneration
        && !(error instanceof DOMException && error.name === "AbortError")) modelsFailure = errorMessage(error);
    } finally {
      if (!disposed && generation === modelsLoadGeneration) modelsLoading = false;
    }
  }

  async function observeAccounts(): Promise<void> {
    let observed = false;
    try {
      observed = await onobserveaccounts(accountObservation.signal);
    } catch {
      // Catalog loading reports actionable account failures; bounded observation retries quietly.
    } finally {
      if (!disposed && !accountObservation.signal.aborted && observed
        && catalog === null && attemptedCatalogGeneration === catalogGeneration && !modelsLoading) {
        void loadModels(false);
      }
      if (!disposed && !accountObservation.signal.aborted) {
        accountObservationTimer = setTimeout(() => void observeAccounts(), 5_000);
      }
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
