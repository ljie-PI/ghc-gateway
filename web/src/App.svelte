<script lang="ts">
  import { onMount, tick } from "svelte";
  import { AdminClient, errorMessage, takeBootstrapToken } from "./api.js";
  import type {
    AdminOperationalEvent,
    AdminSessionMetadata,
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
  let session: AdminSessionMetadata | null = $state(null);
  let phase: "loading" | "ready" | "signed-out" = $state("loading");
  let authError = $state("");
  let streamState: StreamState = $state("connecting");
  let liveStatus: AdminStatus | null = $state(null);
  let liveEvents: AdminOperationalEvent[] = $state([]);
  let resetVersion = $state(0);
  let navOpen = $state(false);
  let mobileNavigation = $state(false);
  let stream: EventSource | null = null;
  let signedOutPanel: HTMLElement | null = $state(null);
  let workspace: HTMLElement | null = $state(null);
  let menuButton: HTMLButtonElement | null = $state(null);
  let navigation: HTMLElement | null = $state(null);
  let pageNumber = $derived(String(views.indexOf(view) + 1).padStart(2, "0"));
  const client = new AdminClient(teardown);

  onMount(() => {
    updateNavigationMode();
    window.addEventListener("resize", updateNavigationMode);
    void authenticate();
    return () => {
      window.removeEventListener("resize", updateNavigationMode);
      closeStream();
    };
  });

  function updateNavigationMode(): void {
    mobileNavigation = menuButton !== null && getComputedStyle(menuButton).display !== "none";
    if (!mobileNavigation) navOpen = false;
  }

  async function authenticate(): Promise<void> {
    phase = "loading";
    authError = "";
    const token = takeBootstrapToken();
    try {
      session = token === null ? await client.session() : await client.bootstrap(token);
      phase = "ready";
      await tick();
      updateNavigationMode();
      openStream();
    } catch (error: unknown) {
      phase = "signed-out";
      authError = token === null ? "Open Admin with `ghcg admin open`." : errorMessage(error);
      requestAnimationFrame(() => signedOutPanel?.focus());
    }
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
      void client.session().catch(() => undefined);
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

  function teardown(): void {
    closeStream();
    client.clear();
    session = null;
    liveStatus = null;
    liveEvents = [];
    navOpen = false;
    phase = "signed-out";
    authError = "Your admin session ended. Run `ghcg admin open` to reconnect.";
    requestAnimationFrame(() => signedOutPanel?.focus());
  }

  async function logout(): Promise<void> {
    try {
      await client.logout();
    } catch {
      // Local teardown is mandatory even if the daemon stopped.
    }
    teardown();
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

{#if phase === "loading"}
  <main class="auth-stage" aria-busy="true">
    <TerminalMark class="auth-mark" />
    <p class="eyebrow">LOCAL ADMINISTRATION</p>
    <h1>Establishing a secure session</h1>
    <p class="muted">The one-time bootstrap is being exchanged in memory.</p>
  </main>
{:else if phase === "signed-out"}
  <main class="auth-stage">
    <section class="signed-out" aria-labelledby="signed-out-title">
      <span class="status-dot stopped" aria-hidden="true"></span>
      <p class="eyebrow">SESSION CLOSED</p>
      <h1 id="signed-out-title" tabindex="-1" bind:this={signedOutPanel}>Admin session closed</h1>
      <p>{authError}</p>
      <button class="primary" onclick={authenticate}>Try current session</button>
    </section>
  </main>
{:else}
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
        <span>Admin Session</span>
        <time datetime={session?.idleExpiresAt}>
          idle until {session
            ? new Date(session.idleExpiresAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })
            : "-"}
        </time>
        <button class="text-button" onclick={logout}>End session</button>
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
            <Accounts {client} {pageNumber} />
          {:else if view === "Models"}
            <Models {client} {pageNumber} />
          {:else if view === "Agents"}
            <Agents {client} {pageNumber} />
          {:else if view === "Configuration"}
            <Configuration {client} {pageNumber} />
          {:else}
            <Events {client} {liveEvents} {resetVersion} {streamState} {pageNumber} />
          {/if}
        </main>
      </div>
    </div>
  </div>
{/if}
