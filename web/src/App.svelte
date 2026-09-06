<script lang="ts">
  import { onMount, tick } from "svelte";
  import { AdminClient, errorMessage, takeBootstrapToken } from "./api.js";
  import type {
    AdminOperationalEvent,
    AdminSessionMetadata,
    AdminStatus,
    StreamState,
  } from "./types.js";
  import Accounts from "./views/Accounts.svelte";
  import Configuration from "./views/Configuration.svelte";
  import Events from "./views/Events.svelte";
  import Models from "./views/Models.svelte";
  import Overview from "./views/Overview.svelte";
  import ResponsesHistory from "./views/ResponsesHistory.svelte";

  const views = ["Overview", "Accounts", "Models", "Configuration", "Responses History", "Events"] as const;
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
  const client = new AdminClient(teardown);

  onMount(() => {
    const media = matchMedia("(max-width: 850px)");
    const updateNavigationMode = (): void => {
      mobileNavigation = media.matches;
      if (!mobileNavigation) navOpen = false;
    };
    updateNavigationMode();
    media.addEventListener("change", updateNavigationMode);
    void authenticate();
    return () => {
      media.removeEventListener("change", updateNavigationMode);
      closeStream();
    };
  });

  async function authenticate(): Promise<void> {
    phase = "loading";
    authError = "";
    const token = takeBootstrapToken();
    try {
      session = token === null ? await client.session() : await client.bootstrap(token);
      phase = "ready";
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
      liveEvents = [...liveEvents, value.event].slice(-512);
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
    <svg class="auth-mark" viewBox="0 0 40 40" aria-hidden="true">
      <rect x="2" y="2" width="36" height="36" rx="4" fill="currentColor" />
      <path d="m11 13 7 7-7 7m12 0h6" fill="none" stroke="var(--canvas)" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" />
    </svg>
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
    >
      <div class="brand">
        <svg class="brand-mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
          <rect x="2" y="2" width="36" height="36" rx="4" fill="currentColor" />
          <path d="m11 13 7 7-7 7m12 0h6" fill="none" stroke="var(--canvas)" stroke-width="2" stroke-linecap="square" stroke-linejoin="miter" />
        </svg>
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
            <span class="nav-index">[{String(index + 1).padStart(2, "0")}]</span>
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
      </div>
    </aside>
    {#if navOpen}
      <button class="nav-backdrop" aria-label="Close navigation" onclick={() => closeNavigation()}></button>
    {/if}
    <div class="main-column">
      <div class="content-frame">
        <header class="utility-bar">
          <div class="utility-location">
            <button
              class="mobile-menu"
              aria-label="Open navigation"
              aria-expanded={navOpen}
              aria-controls="admin-navigation"
              bind:this={menuButton}
              onclick={() => void openNavigation()}
            >[=]</button>
            <span>ADMIN / {view.toUpperCase()}</span>
          </div>
          <div class="utility-actions">
            <span class="desktop-stream stream-state" aria-live="polite">
              <span class:reconnecting={streamState !== "live"} class="status-dot"></span>
              {streamState}
            </span>
            <button class="text-button" onclick={logout}>End session</button>
          </div>
        </header>
        <main id="admin-content" class="workspace" bind:this={workspace}>
          {#if view === "Overview"}
            <Overview {client} {liveStatus} />
          {:else if view === "Accounts"}
            <Accounts {client} />
          {:else if view === "Models"}
            <Models {client} />
          {:else if view === "Configuration"}
            <Configuration {client} />
          {:else if view === "Responses History"}
            <ResponsesHistory {client} />
          {:else}
            <Events {client} {liveEvents} {resetVersion} {streamState} />
          {/if}
        </main>
        <footer class="footer-note">
          <span>ghc-gateway / local administration</span>
          <span>Loopback only · content-free operations</span>
        </footer>
      </div>
    </div>
  </div>
{/if}
