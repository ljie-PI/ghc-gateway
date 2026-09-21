<script lang="ts">
  import { onMount, tick } from "svelte";
  import { AdminClient } from "./api.js";
  import type { AgentStatus, AgentsView } from "../../src/agents/types.js";
  import type { AdminAccounts, AdminAgentModels } from "../../src/admin/api.js";
  import { AccountRevisionObserver } from "./account_revisions.js";
  import { CachedResource } from "./cached_resource.js";
  import type {
    AdminOperationalEvent,
    AdminStatus,
    StreamState,
  } from "./types.js";
  import Agents from "./views/Agents.svelte";
  import Accounts from "./views/Accounts.svelte";
  import Configuration from "./views/Configuration.svelte";
  import Events from "./views/Events.svelte";
  import Models from "./views/Models.svelte";
  import Overview from "./views/Overview.svelte";
  import TerminalMark from "./TerminalMark.svelte";

  const views = ["Overview", "Accounts", "Models", "Agents", "Configuration", "Events"] as const;
  type View = typeof views[number];

  let view: View = $state("Overview");
  let streamState: StreamState = $state("connecting");
  let liveStatus: AdminStatus | null = $state(null);
  let liveEvents: AdminOperationalEvent[] = $state([]);
  let resetVersion = $state(0);
  let navOpen = $state(false);
  let mobileNavigation = $state(false);
  let stream: EventSource | null = null;
  let workspace: HTMLElement | null = $state(null);
  let menuButton: HTMLButtonElement | null = $state(null);
  let navigation: HTMLElement | null = $state(null);
  let agentsSnapshot: AgentsView | null = $state(null);
  let agentModelsSnapshot: AdminAgentModels | null = $state(null);
  let agentModelsGeneration = $state(0);
  let pageNumber = $derived(String(views.indexOf(view) + 1).padStart(2, "0"));
  const client = new AdminClient();
  const agentsResource = new CachedResource((signal) => client.agents(signal), (value) => { agentsSnapshot = value; });
  const agentModelsResource = new CachedResource((signal) => client.agentModels(signal), (value) => { agentModelsSnapshot = value; });
  const accountRevisions = new AccountRevisionObserver();

  onMount(() => {
    updateNavigationMode();
    window.addEventListener("resize", updateNavigationMode);
    openStream();
    return () => {
      window.removeEventListener("resize", updateNavigationMode);
      closeStream();
      clearAgentsSnapshot();
      accountRevisions.reset();
    };
  });

  function updateNavigationMode(): void {
    mobileNavigation = menuButton !== null && getComputedStyle(menuButton).display !== "none";
    if (!mobileNavigation) navOpen = false;
  }

  function openStream(): void {
    closeStream();
    streamState = "connecting";
    stream = new EventSource("/admin/api/v1/events/stream");
    stream.onopen = () => {
      streamState = "live";
    };
    stream.onerror = () => {
      streamState = "reconnecting";
    };
    stream.addEventListener("performance", (event) => {
      const value = JSON.parse((event as MessageEvent<string>).data) as { status: AdminStatus };
      liveStatus = value.status;
    });
    stream.addEventListener("operational", (event) => {
      const value = JSON.parse((event as MessageEvent<string>).data) as { event: AdminOperationalEvent };
      liveEvents = [
        ...liveEvents.filter((item) => item.eventId !== value.event.eventId),
        value.event,
      ].slice(-512);
    });
    stream.addEventListener("reset", () => {
      liveEvents = [];
      resetVersion += 1;
    });
  }

  function closeStream(): void {
    stream?.close();
    stream = null;
  }

  function clearAgentsSnapshot(): void {
    agentsResource.replace(null);
    clearAgentModels(false);
  }

  function clearAgentModels(reload = true): void {
    if (reload) agentModelsGeneration += 1;
    agentModelsResource.replace(null);
  }

  function observeAccounts(accounts: AdminAccounts): void {
    if (accountRevisions.observe(accounts)) clearAgentModels();
  }

  async function readAccountRevisions(signal: AbortSignal): Promise<boolean> {
    observeAccounts(await client.accounts(signal));
    return accountRevisions.hasBaseline();
  }

  function loadAgents(refresh = false): Promise<AgentsView> {
    return agentsResource.load(refresh);
  }

  function updateAgent(status: AgentStatus): void {
    if (agentsSnapshot === null) return;
    const snapshot = agentsSnapshot;
    agentsResource.replace({
      ...snapshot,
      items: snapshot.items.map((item) => item.id === status.id ? status : item),
    });
  }

  async function navigate(next: View): Promise<void> {
    view = next;
    navOpen = false;
    await tick();
    workspace?.querySelector<HTMLElement>("h1")?.focus();
  }

  async function openNavigation(): Promise<void> {
    navOpen = true;
    await tick();
    navigation?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
  }

  function closeNavigation(restoreFocus = true): void {
    if (!navOpen) return;
    navOpen = false;
    if (restoreFocus) requestAnimationFrame(() => menuButton?.focus());
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && navOpen) closeNavigation();
  }
</script>

<svelte:head>
  <meta name="description" content="Local ghc-gateway administration" />
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<a class="skip-link" href="#admin-content">Skip to content</a>
<div class="shell">
    <aside
      id="admin-navigation"
      class:open={navOpen}
      class="sidebar"
      aria-label="Primary navigation"
      aria-hidden={mobileNavigation && !navOpen}
      inert={mobileNavigation && !navOpen ? true : undefined}
      data-layout-region="navigation"
    >
      <div class="brand">
        <TerminalMark class="brand-mark" />
        <strong>ghc-gateway</strong>
      </div>
      <p class="nav-caption">WORKSPACE</p>
      <nav bind:this={navigation}>
        {#each views as item, index (item)}
          <button
            class="nav-item"
            class:active={view === item}
            aria-current={view === item ? "page" : undefined}
            onclick={() => void navigate(item)}
          >
            <span class="nav-index" aria-hidden="true">[{String(index + 1).padStart(2, "0")}]</span>
            <span>{item}</span>
          </button>
        {/each}
      </nav>
      <div class="sidebar-foot">
        <span class="stream-state" aria-live="polite">
          <span class:reconnecting={streamState !== "live"} class="status-dot"></span>
          {streamState}
        </span>
      </div>
    </aside>
    {#if navOpen}
      <button class="nav-backdrop" aria-label="Close navigation" onclick={() => closeNavigation()}></button>
    {/if}
    <div class="main-column" data-layout-region="main-column">
      <div class="content-frame" data-layout-region="content-frame">
        <button
          class="mobile-menu"
          aria-label="Open navigation"
          aria-expanded={navOpen}
          aria-controls="admin-navigation"
          bind:this={menuButton}
          onclick={() => void openNavigation()}
        >[=]</button>
        <main id="admin-content" class="workspace" bind:this={workspace}>
          {#if view === "Overview"}
            <Overview {client} {liveStatus} {pageNumber} />
          {:else if view === "Accounts"}
            <Accounts {client} {pageNumber} onaccounts={observeAccounts} />
          {:else if view === "Models"}
            <Models {client} {pageNumber} onchanged={clearAgentModels} />
          {:else if view === "Agents"}
            <Agents
              {client}
              {pageNumber}
              data={agentsSnapshot}
              catalog={agentModelsSnapshot}
              catalogGeneration={agentModelsGeneration}
              onload={loadAgents}
              onloadmodels={(refresh) => agentModelsResource.load(refresh)}
              onobserveaccounts={readAccountRevisions}
              onchanged={updateAgent}
            />
          {:else if view === "Configuration"}
            <Configuration {client} {pageNumber} />
          {:else}
            <Events {client} {liveEvents} {resetVersion} {streamState} {pageNumber} />
          {/if}
        </main>
      </div>
    </div>
</div>
