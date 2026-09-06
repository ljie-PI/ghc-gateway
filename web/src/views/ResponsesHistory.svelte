<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, errorMessage, type AdminClient } from "../api.js";
  import type { AdminHistorySummary } from "../types.js";

  let { client, pageNumber }: { client: AdminClient; pageNumber: string } = $props();
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
    if (!data || !confirm("Clear Responses tool checkpoints, route receipts, legacy rows, and continuation policy state?")) return;
    clearing = true;
    failure = "";
    try {
      data = await client.clearHistory(data.revision);
      message = "Responses history and route ownership state cleared.";
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
    <p class="eyebrow">[{pageNumber}] LOCAL ADMINISTRATION</p>
    <h1 tabindex="-1">Responses History</h1>
    <p>Inspect bounded bridge checkpoints without exposing response content.</p>
  </div>
  <button class="danger" onclick={clear} disabled={(!data?.count && !data?.receiptCount && !data?.untrackedContinuationBlocked) || clearing}>
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
      <div><span>Route receipts</span><strong>{data.receiptCount} / {data.maxReceipts}</strong></div>
      <div><span>Legacy unowned</span><strong>{data.legacyCount}</strong></div>
      <div>
        <span>TTL / native policy</span>
        <strong>{data.ttlDays} days · {data.untrackedContinuationBlocked ? "blocked" : "direct only"}</strong>
      </div>
    </div>
    <div class="history-copy">
      <p class="eyebrow">RETAINED CHECKPOINTS</p>
      <h2>
        {data.count > 0
          ? "Responses state is within bounds"
          : data.receiptCount > 0 || data.legacyCount > 0 || data.untrackedContinuationBlocked
            ? "No tool checkpoints retained"
            : "Responses state is empty"}
      </h2>
      <p>
        Tool checkpoints stay separate from content-free route receipts. Native Responses create
        receipts but never enter the tool-history count. Oldest checkpoint:
        {data.oldestAt ? new Date(data.oldestAt).toLocaleString() : "none"}; newest:
        {data.newestAt ? new Date(data.newestAt).toLocaleString() : "none"}; revision {data.revision}.
      </p>
    </div>
  </section>
{/if}
