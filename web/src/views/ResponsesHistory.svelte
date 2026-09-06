<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, errorMessage, type AdminClient } from "../api.js";
  import type { AdminHistorySummary } from "../types.js";

  let { client }: { client: AdminClient } = $props();
  let data: AdminHistorySummary | null = $state(null);
  let loading = $state(true);
  let clearing = $state(false);
  let failure = $state("");
  let message = $state("");

  onMount(load);

  async function load(preserveFailure = false): Promise<void> {
    loading = true;
    if (!preserveFailure) failure = "";
    try {
      data = await client.history();
    } catch (error: unknown) {
      failure = errorMessage(error);
    } finally {
      loading = false;
    }
  }

  async function clear(): Promise<void> {
    if (!data || !confirm("Clear all retained Responses bridge history?")) return;
    clearing = true;
    failure = "";
    try {
      data = await client.clearHistory(data.revision);
      message = "Responses history cleared.";
    } catch (error: unknown) {
      failure = errorMessage(error);
      if (error instanceof ApiError && error.status === 409) await load(true);
    } finally {
      clearing = false;
    }
  }
</script>

<header class="page-head">
  <div>
    <p class="eyebrow">[05] LOCAL ADMINISTRATION</p>
    <h1 tabindex="-1">Responses History</h1>
    <p>Inspect bounded bridge checkpoints without exposing response content.</p>
  </div>
  <button class="danger" onclick={clear} disabled={!data?.count || clearing}>
    {clearing ? "Clearing..." : "Clear history"}
  </button>
</header>

{#if message}
  <p class="notice success" role="status">{message}</p>
{/if}
{#if failure}
  <p class="notice error" role="alert">{failure}</p>
{/if}

{#if loading}
  <p class="loading-line" aria-busy="true">Inspecting history...</p>
{:else if data}
  <section class="history-summary">
    <div class="fact-strip">
      <div><span>Checkpoints</span><strong>{data.count} / {data.maxResponses}</strong></div>
      <div><span>Oldest</span><strong>{data.oldestAt ? new Date(data.oldestAt).toLocaleString() : "None"}</strong></div>
      <div><span>Newest</span><strong>{data.newestAt ? new Date(data.newestAt).toLocaleString() : "None"}</strong></div>
      <div><span>TTL / revision</span><strong>{data.ttlDays} days · {data.revision}</strong></div>
    </div>
    <div class="history-copy">
      <p class="eyebrow">RETAINED CHECKPOINTS</p>
      <h2>{data.count === 0 ? "History is empty" : "History is within bounds"}</h2>
      <p>
        Only completed Semantic Checkpoints from bridged Responses are retained. Native Responses
        never enter this store, and response content is not shown here.
      </p>
    </div>
  </section>
{/if}
