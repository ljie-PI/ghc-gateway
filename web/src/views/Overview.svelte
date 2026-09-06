<script lang="ts">
  import { onMount } from "svelte";
  import { errorMessage, type AdminClient } from "../api.js";
  import type { AdminStatus, AdminUsagePage } from "../types.js";

  let { client, liveStatus }: { client: AdminClient; liveStatus: AdminStatus | null } = $props();
  let status: AdminStatus | null = $state(null);
  let usage: AdminUsagePage | null = $state(null);
  let loading = $state(true);
  let failure = $state("");
  let current = $derived(liveStatus ?? status);

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    failure = "";
    try {
      [status, usage] = await Promise.all([client.status(), client.usage()]);
    } catch (error: unknown) {
      failure = errorMessage(error);
    } finally {
      loading = false;
    }
  }

  const number = (value: number): string => new Intl.NumberFormat().format(value);
</script>

<header class="page-head">
  <div>
    <p class="eyebrow">[01] LOCAL ADMINISTRATION</p>
    <h1 tabindex="-1">Overview</h1>
    <p>Health, usage, performance and bounded storage from the running gateway.</p>
  </div>
  <button onclick={load}>Refresh</button>
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
      <span class="chip">{usage.items.length} buckets</span>
    </div>
    <p class="muted small">Content-free totals for the last 24 hours.</p>
    <div class="stat-row">
      <div><span>Requests</span><strong>{number(usage.totals.requestCount)}</strong></div>
      <div><span>Errors</span><strong>{number(usage.totals.errorCount)}</strong></div>
      <div><span>Input tokens</span><strong>{number(usage.totals.inputTokens)}</strong></div>
      <div><span>Output tokens</span><strong>{number(usage.totals.outputTokens)}</strong></div>
    </div>
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
