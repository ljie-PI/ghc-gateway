<script lang="ts">
  import { onMount } from "svelte";
  import { errorMessage, type AdminClient } from "../api.js";
  import type { AgentsView, AgentStatus } from "../../../src/agents/types.js";
  import AgentCard from "./AgentCard.svelte";

  let {
    client,
    pageNumber,
    data,
    onload,
    onchanged,
  }: {
    client: AdminClient;
    pageNumber: string;
    data: AgentsView | null;
    onload: (refresh?: boolean) => Promise<AgentsView>;
    onchanged: (status: AgentStatus) => void;
  } = $props();
  let loading = $state(false);
  let failure = $state("");
  let disposed = false;
  const orderedItems = $derived(data?.items.toSorted((left, right) =>
    (left.id === "codex" ? 0 : 1) - (right.id === "codex" ? 0 : 1)) ?? []);

  onMount(() => {
    if (data === null) void load(false);
    return () => { disposed = true; };
  });

  async function load(refresh: boolean): Promise<void> {
    loading = true;
    failure = "";
    try {
      await onload(refresh);
    } catch (error: unknown) {
      if (!disposed) failure = errorMessage(error);
    } finally {
      if (!disposed) loading = false;
    }
  }
</script>

<header class="page-head">
  <div>
    <p class="eyebrow">[{pageNumber}] LOCAL ADMINISTRATION</p>
    <h1 tabindex="-1">Agents</h1>
    <p>Reversible global configuration for this Gateway process user.</p>
  </div>
  <button class="primary" disabled={loading} onclick={() => void load(true)}>Refresh</button>
</header>
{#if failure}<p class="notice error" role="alert">{failure}</p>{/if}
{#if data}
  {#if !data.modelsAvailable}<p class="notice" role="status">Model catalog unavailable. Sign in and configure usable model capabilities in Models before applying. Inspection and Restore do not require a Copilot account.</p>{/if}
  <div class="agent-cards">
    {#each orderedItems as status (status.id)}
      <AgentCard {client} {status} catalogRevision={data.catalogRevision} {onchanged} />
    {/each}
  </div>
{:else if loading}<p class="loading-line" aria-busy="true">Reading agent configuration...</p>{/if}
