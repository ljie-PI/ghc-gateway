<script lang="ts">
  import { onMount } from "svelte";
  import { errorMessage, type AdminClient } from "../api.js";
  import type { AdminStatus, AdminUsagePage } from "../types.js";

  let {
    client,
    liveStatus,
    pageNumber,
  }: { client: AdminClient; liveStatus: AdminStatus | null; pageNumber: string } = $props();
  const windows = [
    { key: "24h", label: "Last 24 hours" },
    { key: "7d", label: "Last 7 days" },
    { key: "28d", label: "Last 28 days" },
  ] as const;
  let status: AdminStatus | null = $state(null);
  let usage: { label: string; totals: AdminUsagePage["totals"] }[] | null = $state(null);
  let loading = $state(true);
  let failure = $state("");
  let current = $derived(liveStatus ?? status);

  let loadAbort: AbortController | null = null;
  let disposed = false;

  onMount(() => {
    void load();
    return () => {
      disposed = true;
      loadAbort?.abort();
    };
  });

  async function load(): Promise<void> {
    if (loadAbort !== null || disposed) return;
    const controller = new AbortController();
    loadAbort = controller;
    loading = true;
    failure = "";
    const requests = [
      client.status(controller.signal),
      ...windows.map(async (window) => ({
        label: window.label,
        totals: (await client.usage(window.key, controller.signal)).totals,
      })),
    ] as const;
    try {
      const [loadedStatus, ...loadedUsage] = await Promise.all(requests);
      if (!disposed) {
        status = loadedStatus;
        usage = loadedUsage;
      }
    } catch (error: unknown) {
      controller.abort();
      await Promise.allSettled(requests);
      if (!disposed) failure = errorMessage(error);
    } finally {
      loadAbort = null;
      if (!disposed) loading = false;
    }
  }

  const number = (value: number): string => new Intl.NumberFormat().format(value);
</script>

<header class="page-head">
  <div>
    <p class="eyebrow">[{pageNumber}] LOCAL ADMINISTRATION</p>
    <h1 tabindex="-1">Overview</h1>
    <p>Health, usage, performance and bounded storage from the running gateway.</p>
  </div>
  <button class="primary" onclick={load} disabled={loading}>Refresh</button>
</header>

{#if loading}
  <div class="skeleton-grid" aria-label="Loading overview" aria-busy="true"><i></i><i></i><i></i></div>
{:else if failure}
  <section class="notice error" role="alert">
    <strong>Overview unavailable</strong>
    <p>{failure}</p>
    <button onclick={load}>Retry</button>
  </section>
{:else if current && usage}
  {#if current.performance === "degraded"}
    <section class="degraded" role="status">
      <div><p class="eyebrow">PERFORMANCE WATCH</p><h2>Gateway is degraded</h2></div>
      <p>Health remains OK. Limits and routing are unchanged while metrics recover.</p>
    </section>
  {/if}
  <section class="hero-metrics" aria-label="Gateway status">
    <article>
      <p>Gateway</p>
      <strong>{current.health === "ok" ? "Running" : current.health}</strong>
      <small><span class="status-dot"></span> v{current.version} · up {Math.floor(current.uptimeMs / 60000)} min</small>
    </article>
    <article>
      <p>Active requests</p>
      <strong>{current.admission.activeRequests}<small> / {current.admission.activeMax}</small></strong>
      <meter min="0" max={current.admission.activeMax} value={current.admission.activeRequests}>
        {current.admission.activeRequests}
      </meter>
    </article>
    <article>
      <p>Streaming now</p>
      <strong>{current.admission.activeStreams}</strong>
      <small>{current.admission.queuedRequests} queued</small>
    </article>
  </section>
  <section class="section">
    <div class="section-heading">
      <h2><span class="section-number">[01]</span>Usage ledger</h2>
    </div>
    <p class="usage-note">Only retained hourly usage buckets are included.</p>
    {#each usage as window (window.label)}
      <section class="usage-window" aria-label={window.label}>
        <h3>{window.label}</h3>
        <div class="stat-row">
          <div><span>Requests</span><strong>{number(window.totals.requestCount)}</strong></div>
          <div><span>Errors</span><strong>{number(window.totals.errorCount)}</strong></div>
          <div><span>Input tokens</span><strong>{number(window.totals.inputTokens)}</strong></div>
          <div><span>Output tokens</span><strong>{number(window.totals.outputTokens)}</strong></div>
          <div><span title="Cache read + write tokens, already included in input tokens">Cache tokens</span><strong>{number(window.totals.cacheTokens)}</strong></div>
        </div>
      </section>
    {/each}
  </section>
  <section class="split-panels section">
    <article>
      <div class="section-heading">
        <h2><span class="section-number">[02]</span>Performance windows</h2>
        <span class:warning={current.performance === "degraded"} class="chip">{current.performance}</span>
      </div>
      <ul class="metric-list">
        {#each current.performanceMetrics as metric (metric.metric)}
          <li>
            <span>{metric.metric.replaceAll("_", " ")}</span>
            <strong>{metric.actual === null ? "Collecting" : `${metric.actual} ms`}</strong>
            <small>limit {metric.threshold} ms</small>
          </li>
        {/each}
      </ul>
    </article>
    <article>
      <div class="section-heading"><h2><span class="section-number">[03]</span>Bounded storage</h2></div>
      <ul class="storage-list">
        <li><span>Responses history</span><strong>{current.storage.historyCount}</strong></li>
        <li><span>Usage buckets</span><strong>{current.storage.usageBucketCount}</strong></li>
        <li><span>Operational events</span><strong>{current.storage.eventCount} / 512</strong></li>
      </ul>
    </article>
  </section>
{/if}

<style>
  .usage-note { color: var(--muted); font-size: 13px; }
  .usage-window + .usage-window { margin-top: 24px; }
</style>
