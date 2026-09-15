<script lang="ts">
  import { onMount } from "svelte";
  import { errorMessage, type AdminClient } from "../api.js";
  import type { AdminOperationalEvent, StreamState } from "../types.js";

  let {
    client,
    liveEvents,
    resetVersion,
    streamState,
    pageNumber,
  }: {
    client: AdminClient;
    liveEvents: AdminOperationalEvent[];
    resetVersion: number;
    streamState: StreamState;
    pageNumber: string;
  } = $props();
  let persisted: AdminOperationalEvent[] = $state([]);
  let cursor: string | null = $state(null);
  let loading = $state(true);
  let failure = $state("");
  let severity = $state("all");
  let seenReset = $state(0);
  let loadGeneration = 0;

  let all = $derived.by(() => {
    const merged = new Map([...persisted, ...liveEvents].map((event) => [event.eventId, event]));
    return [...merged.values()]
      .sort(newestFirst)
      .slice(0, 512)
      .filter((event) => severity === "all" || event.severity === severity);
  });

  onMount(() => load(false));

  $effect(() => {
    const version = resetVersion;
    if (version !== seenReset) {
      seenReset = version;
      void load(false);
    }
  });

  async function load(more: boolean): Promise<void> {
    const generation = ++loadGeneration;
    loading = true;
    failure = "";
    try {
      const page = await client.events(more && cursor ? cursor : undefined);
      if (generation !== loadGeneration) return;
      persisted = more
        ? [...persisted, ...page.items].slice(-512)
        : [...page.items].slice(-512);
      cursor = page.nextCursor;
    } catch (error: unknown) {
      if (generation === loadGeneration) failure = errorMessage(error);
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  function metadata(event: AdminOperationalEvent): string {
    return JSON.stringify(event.metadata, null, 2);
  }

  function newestFirst(a: AdminOperationalEvent, b: AdminOperationalEvent): number {
    const left = BigInt(a.eventId);
    const right = BigInt(b.eventId);
    return left === right ? 0 : left > right ? -1 : 1;
  }
</script>

<header class="page-head">
  <div>
    <p class="eyebrow">[{pageNumber}] LOCAL ADMINISTRATION</p>
    <h1 tabindex="-1">Events</h1>
    <p>Gateway lifecycle, account, error, and performance events. No prompt or response bodies.</p>
  </div>
  <div class="live-badge" aria-live="polite">
    <span class:reconnecting={streamState !== "live"} class="status-dot"></span>
    {streamState}
  </div>
</header>

<section class="toolbar">
  <label for="severity">Severity</label>
  <select id="severity" bind:value={severity}>
    <option value="all">All severities</option>
    <option value="info">Info</option>
    <option value="warning">Warning</option>
    <option value="error">Error</option>
  </select>
  <span class="subtle">Showing {all.length} · maximum 512 in memory</span>
</section>

{#if failure}
  <p class="notice error" role="alert">{failure}</p>
{/if}

{#if loading && persisted.length === 0}
  <p class="loading-line" aria-busy="true">Loading operational events...</p>
{:else if all.length === 0}
  <section class="empty">
    <span>00</span>
    <h2>No matching events</h2>
    <p>Operational events contain sanitized metadata only.</p>
  </section>
{:else}
  <ol class="event-list" aria-label="Operational events">
    {#each all as event (event.eventId)}
      <li class="event-row severity-{event.severity}">
        <time datetime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time>
        <span class="chip">{event.severity}</span>
        <details>
          <summary>{event.kind.replaceAll("_", " ")}</summary>
          <pre>{metadata(event)}</pre>
        </details>
        <span class="event-id">EVENT {event.eventId}</span>
      </li>
    {/each}
  </ol>
  {#if cursor}
    <button class="load-more" onclick={() => load(true)} disabled={loading}>
      {loading ? "Loading..." : "Load newer events"}
    </button>
  {/if}
{/if}

<style>
  .live-badge {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--muted);
    font-size: 13px;
    text-transform: uppercase;
  }

  .event-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .event-row {
    display: grid;
    grid-template-columns: 160px 90px minmax(0, 1fr) 90px;
    gap: 18px;
    align-items: start;
    padding: 16px 0;
    border-bottom: 1px solid var(--line);
    font-size: 14px;
  }

  .event-row time,
  .event-id {
    color: var(--muted);
    font-size: 13px;
  }

  .event-row details {
    min-width: 0;
  }

  .event-row summary {
    cursor: pointer;
    font-weight: 700;
    text-transform: capitalize;
  }

  .event-row pre {
    margin-top: 10px;
    padding: 12px;
    background: var(--soft);
    color: var(--muted);
    font-size: 13px;
  }

  .load-more {
    margin-top: 18px;
  }

  @media (max-width: 600px) {
    .event-row {
      grid-template-columns: 80px minmax(0, 1fr);
      gap: 8px 12px;
    }

    .event-row details {
      grid-column: 1 / -1;
    }

    .event-id {
      text-align: right;
    }
  }
</style>
