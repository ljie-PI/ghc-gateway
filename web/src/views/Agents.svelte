<script lang="ts">
  import { onMount } from "svelte";
  import { errorMessage, type AdminClient } from "../api.js";
  import type { AgentsView, AgentStatus } from "../../../src/agents/types.js";
  import AgentCard from "./AgentCard.svelte";
  let { client, pageNumber }: { client: AdminClient; pageNumber: string } = $props();
  let data: AgentsView | null = $state(null);
  let loading = $state(false);
  let failure = $state("");
  onMount(() => { void load(); });
  async function load(): Promise<void> {
    loading = true;
    failure = "";
    try { data = await client.agents(); }
    catch (error: unknown) { failure = errorMessage(error); }
    finally { loading = false; }
  }
  function changed(status: AgentStatus): void {
    if (data) data = { ...data, items: data.items.map((item) => item.id === status.id ? status : item) };
  }
</script>
<header class="page-head">
  <div>
    <p class="eyebrow">[{pageNumber}] LOCAL ADMINISTRATION</p>
    <h1 tabindex="-1">Agents</h1>
    <p>Reversible global configuration for this Gateway process user.</p>
  </div>
  <button disabled={loading} onclick={() => void load()}>Refresh</button>
</header>
<p class="muted">Refresh only reads configuration. Status means configuration installed, not a tested client or inference connection. Preferred Model and account selection are unchanged.</p>
<p class="muted">Restart clients after applying or restoring. Command-line, project and managed-policy overrides are outside these global settings; do not use routing overrides with this integration.</p>
{#if failure}<p class="notice error" role="alert">{failure}</p>{/if}
{#if data}
  {#if !data.modelsAvailable}<p class="notice" role="status">Model catalog unavailable. Sign in and configure usable model capabilities in Models before applying. Inspection and Restore do not require a Copilot account.</p>{/if}
  <div class="agent-cards">
    {#each data.items as status (status.id)}
      <AgentCard {client} {status} catalogRevision={data.catalogRevision} onchanged={changed} />
    {/each}
  </div>
{:else if loading}<p class="loading-line" aria-busy="true">Reading agent configuration...</p>{/if}
