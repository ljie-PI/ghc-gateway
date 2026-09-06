<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, errorMessage, type AdminClient } from "../api.js";
  import type { AdminAccounts, DeviceFlow } from "../types.js";

  let { client }: { client: AdminClient } = $props();
  let data: AdminAccounts | null = $state(null);
  let host = $state("github.com");
  let flow: DeviceFlow | null = $state(null);
  let loading = $state(true);
  let busy = $state("");
  let message = $state("");
  let failure = $state("");
  let pollState: "idle" | "waiting" | "checking" | "retrying" = $state("idle");
  let hostInput: HTMLInputElement | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let pollAbort: AbortController | null = null;
  let pollGeneration = 0;
  let loadGeneration = 0;
  let nextPollAtMs = 0;
  let pollIntervalSeconds = 1;

  onMount(() => {
    void load();
    return dispose;
  });

  async function load(
    preserveFailure = false,
    expectedGeneration?: number,
  ): Promise<AdminAccounts | null> {
    const requestGeneration = ++loadGeneration;
    loading = true;
    if (!preserveFailure) failure = "";
    try {
      const loaded = await client.accounts();
      if (
        requestGeneration !== loadGeneration
        || (expectedGeneration !== undefined && expectedGeneration !== pollGeneration)
      ) return null;
      data = loaded;
      return loaded;
    } catch (error: unknown) {
      if (
        requestGeneration !== loadGeneration
        || (expectedGeneration !== undefined && expectedGeneration !== pollGeneration)
      ) return null;
      failure = errorMessage(error);
      return null;
    } finally {
      if (requestGeneration === loadGeneration) loading = false;
    }
  }

  async function start(): Promise<void> {
    const replacedFlowId = flow?.flowId;
    clearFlow();
    loadGeneration += 1;
    loading = false;
    busy = "login";
    failure = "";
    message = "";
    const generation = pollGeneration;
    const controller = new AbortController();
    pollAbort = controller;
    try {
      if (replacedFlowId !== undefined) {
        const canceled = await client.cancelDeviceFlow(replacedFlowId, controller.signal);
        if (generation !== pollGeneration) return;
        if (canceled.state === "complete") {
          const refreshed = await load();
          if (generation !== pollGeneration) return;
          message = connectedMessage(canceled.account, refreshed);
          return;
        }
      }
      const started = await client.startDeviceFlow(host, controller.signal);
      if (generation !== pollGeneration) return;
      flow = started;
      pollIntervalSeconds = started.pollIntervalSeconds;
      nextPollAtMs = Date.parse(started.nextPollAt);
      pollState = "waiting";
      scheduleExpiry(generation);
      schedulePoll(generation);
    } catch (error: unknown) {
      if (generation !== pollGeneration || isAbort(error)) return;
      failure = errorMessage(error);
      hostInput?.focus();
    } finally {
      if (generation === pollGeneration) {
        pollAbort = null;
        busy = "";
      }
    }
  }

  function schedulePoll(generation: number): void {
    if (generation !== pollGeneration || flow === null) return;
    if (pollTimer !== null) clearTimeout(pollTimer);
    const wakeAtMs = nextPollAtMs;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void poll(generation);
    }, Math.max(0, wakeAtMs - Date.now()));
  }

  function scheduleExpiry(generation: number): void {
    if (generation !== pollGeneration || flow === null) return;
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => {
      expiryTimer = null;
      void settleExpiry(generation);
    }, Math.max(0, Date.parse(flow.expiresAt) - Date.now()));
  }

  async function settleExpiry(generation: number): Promise<void> {
    const expiringFlow = flow;
    if (generation !== pollGeneration || expiringFlow === null) return;
    pollState = "checking";
    try {
      const result = await client.cancelDeviceFlow(expiringFlow.flowId);
      if (generation !== pollGeneration) return;
      if (result.state === "complete") {
        clearFlow();
        const completionGeneration = pollGeneration;
        const refreshed = await load(false, completionGeneration);
        if (completionGeneration !== pollGeneration) return;
        message = connectedMessage(result.account, refreshed);
        return;
      }
      finishFlow(generation, "Authorization expired. Start a new login.");
    } catch (error: unknown) {
      if (generation !== pollGeneration) return;
      finishFlow(generation, `Authorization expired: ${errorMessage(error)}`);
    }
  }

  async function poll(generation: number): Promise<void> {
    const activeFlow = flow;
    if (generation !== pollGeneration || activeFlow === null) return;
    const expiresAtMs = Date.parse(activeFlow.expiresAt);
    if (Date.now() >= expiresAtMs) {
      await settleExpiry(generation);
      return;
    }
    if (Date.now() < nextPollAtMs) {
      pollState = "waiting";
      schedulePoll(generation);
      return;
    }
    pollState = "checking";
    const controller = new AbortController();
    pollAbort = controller;
    nextPollAtMs = Math.min(expiresAtMs, Date.now() + pollIntervalSeconds * 1000);
    try {
      const result = await client.pollDeviceFlow(activeFlow.flowId, controller.signal);
      if (generation !== pollGeneration || flow?.flowId !== activeFlow.flowId) return;
      if (result.state === "complete") {
        clearFlow();
        const completionGeneration = pollGeneration;
        const refreshed = await load(false, completionGeneration);
        if (completionGeneration !== pollGeneration) return;
        message = connectedMessage(result.account, refreshed);
      } else if (result.state === "pending") {
        pollIntervalSeconds = result.pollIntervalSeconds;
        nextPollAtMs = Date.parse(result.nextPollAt);
        pollState = "waiting";
        failure = "";
        schedulePoll(generation);
      } else {
        finishFlow(
          generation,
          result.state === "expired"
            ? "Authorization expired. Start a new login."
            : result.state === "denied"
              ? "Authorization was denied in GitHub."
              : "Authorization could not be completed.",
        );
      }
    } catch (error: unknown) {
      if (generation !== pollGeneration || isAbort(error)) return;
      failure = errorMessage(error);
      if (error instanceof ApiError && (error.status === 401 || error.status === 404)) {
        clearFlow();
        return;
      }
      pollState = "retrying";
      message = "Automatic checking will retry at the allowed interval.";
      nextPollAtMs = Math.max(nextPollAtMs, Date.now() + pollIntervalSeconds * 1000);
      schedulePoll(generation);
    } finally {
      if (generation === pollGeneration) pollAbort = null;
    }
  }

  function checkNow(): void {
    if (flow === null) return;
    if (Date.now() < nextPollAtMs) {
      message = `The next check is available at ${new Date(nextPollAtMs).toLocaleTimeString()}.`;
      schedulePoll(pollGeneration);
      return;
    }
    if (pollState !== "checking") void poll(pollGeneration);
  }

  async function cancelFlow(): Promise<void> {
    const canceledFlowId = flow?.flowId;
    clearFlow();
    message = "Authorization canceled in this view.";
    failure = "";
    const cancellationGeneration = pollGeneration;
    if (canceledFlowId === undefined) return;
    try {
      const canceled = await client.cancelDeviceFlow(canceledFlowId);
      if (canceled.state === "complete") {
        const refreshed = await load();
        if (cancellationGeneration !== pollGeneration) return;
        message = connectedMessage(canceled.account, refreshed);
      }
    } catch (error: unknown) {
      if (cancellationGeneration !== pollGeneration) return;
      failure = `The local flow will expire automatically: ${errorMessage(error)}`;
    }
  }

  function finishFlow(generation: number, text: string): void {
    if (generation !== pollGeneration) return;
    clearFlow();
    message = "";
    failure = text;
  }

  function stopPolling(): void {
    pollGeneration += 1;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
    pollAbort?.abort();
    pollAbort = null;
  }

  function clearFlow(): void {
    stopPolling();
    flow = null;
    pollState = "idle";
  }

  function dispose(): void {
    const disposedFlowId = flow?.flowId;
    stopPolling();
    if (disposedFlowId !== undefined) {
      void client.cancelDeviceFlow(disposedFlowId).catch(() => {
        console.warn("Could not cancel device authorization during view disposal.");
      });
    }
  }

  function connectedMessage(
    account: NonNullable<AdminAccounts["items"][number]>,
    refreshed: AdminAccounts | null,
  ): string {
    const identity = account.login === null ? account.numericUserId : `@${account.login}`;
    if (refreshed === null) {
      return `Connected ${identity}. Refresh accounts to confirm the current default.`;
    }
    if (refreshed.defaultAccountId === account.accountId) {
      return `Connected ${identity}; it is the default account.`;
    }
    const currentDefault = refreshed.items.find((item) => item.accountId === refreshed.defaultAccountId);
    const defaultIdentity = currentDefault?.login ?? currentDefault?.numericUserId;
    return defaultIdentity === undefined
      ? `Connected ${identity}. No default account is currently selected.`
      : `Connected ${identity}. Current default is ${currentDefault?.login === null ? defaultIdentity : `@${defaultIdentity}`}.`;
  }

  function isAbort(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
  }

  async function useAccount(id: string): Promise<void> {
    if (!data) return;
    busy = id;
    failure = "";
    try {
      await client.useAccount(id, data.defaultRevision);
      message = "Default account updated.";
      await load();
    } catch (error: unknown) {
      failure = errorMessage(error);
      await load(true);
    } finally {
      busy = "";
    }
  }

  async function remove(id: string, revision: number): Promise<void> {
    if (!confirm("Remove this account's credentials and live caches?")) return;
    busy = id;
    failure = "";
    try {
      await client.removeAccount(id, revision);
      message = "Account removed.";
      await load();
    } catch (error: unknown) {
      failure = errorMessage(error);
      await load(true);
    } finally {
      busy = "";
    }
  }
</script>

<header class="page-head">
  <div>
    <p class="eyebrow">IDENTITY ROSTER</p>
    <h1 tabindex="-1">Accounts</h1>
    <p>Connect GitHub.com or GHES and choose the request identity.</p>
  </div>
  <button class="quiet" onclick={() => void load()}>Refresh</button>
</header>

{#if message}
  <p class="notice success" role="status">{message}</p>
{/if}
{#if failure}
  <p class="notice error" role="alert">{failure}</p>
{/if}

<section class="section-block connect-panel">
  <div>
    <p class="eyebrow">DEVICE AUTHORIZATION</p>
    <h2>Connect an account</h2>
  </div>
  <form onsubmit={(event) => { event.preventDefault(); void start(); }}>
    <label for="github-host">GitHub host</label>
    <div class="inline-form">
      <input
        id="github-host"
        bind:this={hostInput}
        bind:value={host}
        required
        placeholder="github.com or github.example.com"
      />
      <button class="primary" disabled={busy === "login"}>
        {busy === "login" ? "Starting..." : flow === null ? "Start login" : "Replace login"}
      </button>
    </div>
  </form>
</section>

{#if flow}
  <section class="device-flow" aria-labelledby="device-title" aria-live="polite">
    <div>
      <p class="eyebrow">ONE-TIME CODE</p>
      <h2 id="device-title">Continue in GitHub</h2>
      <code>{flow.userCode}</code>
      <p>
        {pollState === "checking"
          ? "Checking GitHub now..."
          : pollState === "retrying"
            ? "The last check failed; retrying automatically."
            : "Waiting for GitHub approval; checking automatically."}
      </p>
      <small>Expires {new Date(flow.expiresAt).toLocaleString()}. Keep this view open to finish connecting.</small>
    </div>
    <div>
      <a class="button primary" href={flow.verificationUri} target="_blank" rel="noreferrer">
        Open verification page
      </a>
      <button onclick={checkNow} disabled={pollState === "checking"}>
        {pollState === "checking" ? "Checking..." : "Check now"}
      </button>
      <button class="quiet" onclick={() => void cancelFlow()}>Cancel</button>
    </div>
  </section>
{/if}

{#if loading}
  <p class="loading-line" aria-busy="true">Loading accounts...</p>
{:else if data?.items.length === 0}
  <section class="empty">
    <span>00</span>
    <h2>No accounts connected</h2>
    <p>Start a device authorization above. Credentials never enter browser storage.</p>
  </section>
{:else if data}
  <section class="card-list" aria-label="Connected accounts">
    {#each data.items as account (account.accountId)}
      <article class:muted-card={account.state !== "active"}>
        <div class="avatar" aria-hidden="true">
          {(account.login ?? account.host).slice(0, 2).toUpperCase()}
        </div>
        <div class="grow">
          <div class="account-title">
            <h2>{account.displayName ?? account.login ?? account.numericUserId}</h2>
            {#if data.defaultAccountId === account.accountId}<span class="chip">DEFAULT</span>{/if}
            <span class="chip state-{account.state}">{account.state}</span>
          </div>
          <p>{account.login ? `@${account.login} · ` : ""}{account.host}</p>
          <small>
            Authenticated {account.authenticatedAt
              ? new Date(account.authenticatedAt).toLocaleString()
              : "not active"}
          </small>
        </div>
        <div class="card-actions">
          {#if account.state === "active" && data.defaultAccountId !== account.accountId}
            <button onclick={() => useAccount(account.accountId)} disabled={busy === account.accountId}>
              Make default
            </button>
          {/if}
          {#if account.state !== "removed"}
            <button
              class="danger-text"
              onclick={() => remove(account.accountId, account.revision)}
              disabled={busy === account.accountId}
            >Remove</button>
          {/if}
        </div>
      </article>
    {/each}
  </section>
{/if}
