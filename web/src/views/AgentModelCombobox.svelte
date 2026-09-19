<script lang="ts">
  import { SvelteSet } from "svelte/reactivity";
  import { onMount, tick } from "svelte";
  import type { AdminAgentModels } from "../../../src/admin/api.js";

  let {
    id,
    label,
    value,
    catalog,
    loading,
    unavailable,
    describedby,
    oninput,
    onselect,
  }: {
    id: string;
    label: string;
    value: string;
    catalog: AdminAgentModels | null;
    loading: boolean;
    unavailable: boolean;
    describedby: string;
    oninput: (value: string) => void;
    onselect: (model: AdminAgentModels["items"][number]) => void;
  } = $props();

  let root: HTMLDivElement;
  let input: HTMLInputElement;
  let listbox = $state<HTMLDivElement>();
  let open = $state(false);
  let activeIndex = $state(-1);
  let opensAbove = $state(false);
  let popupMaxHeight = $state(240);
  let pointerStart: { readonly x: number; readonly y: number } | null = null;
  let suppressPointerClick = false;
  const listboxId = $derived(`${id}-listbox`);
  const statusId = $derived(`${id}-status`);
  const usableModels = $derived.by(() => {
    const seen = new SvelteSet<string>();
    return (catalog?.items ?? []).filter((model) => {
      if (catalog?.usableModelIds.includes(model.id) !== true || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
  });
  const query = $derived(value.trim().toLocaleLowerCase());
  const matches = $derived(loading || unavailable
    ? []
    : query === "" ? usableModels : usableModels.filter((model) =>
      model.id.toLocaleLowerCase().includes(query) || model.name.toLocaleLowerCase().includes(query)));
  const stateMessage = $derived(loading
    ? "Loading model choices"
    : unavailable
      ? "Model catalog unavailable"
      : usableModels.length === 0
        ? "No usable models"
        : matches.length === 0
          ? "No matching models"
          : `${matches.length} model choice${matches.length === 1 ? "" : "s"}`);

  $effect(() => {
    value;
    catalog;
    activeIndex = -1;
  });

  $effect(() => {
    const matchCount = matches.length;
    loading;
    unavailable;
    if (activeIndex >= matchCount || matchCount === 0) activeIndex = -1;
    if (open) void tick().then(placePopup);
  });

  onMount(() => {
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!root.contains(event.target as Node)) close();
    };
    const reposition = (): void => { if (open) placePopup(); };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    window.visualViewport?.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("scroll", reposition);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      window.visualViewport?.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("scroll", reposition);
    };
  });

  async function show(): Promise<void> {
    open = true;
    await tick();
    placePopup();
  }

  function close(): void {
    open = false;
    activeIndex = -1;
  }

  function placePopup(): void {
    if (!open) return;
    const box = root.getBoundingClientRect();
    const popupHeight = Math.min(listbox?.scrollHeight ?? 0, 240);
    const viewportTop = window.visualViewport?.offsetTop ?? 0;
    const viewportBottom = viewportTop + (window.visualViewport?.height ?? window.innerHeight);
    const above = box.top - viewportTop;
    const below = viewportBottom - box.bottom;
    opensAbove = below < popupHeight + 8 && above > below;
    const available = opensAbove ? above : below;
    popupMaxHeight = Math.max(0, Math.min(240, available - 8));
  }

  async function activate(index: number): Promise<void> {
    if (matches.length === 0) return;
    activeIndex = (index + matches.length) % matches.length;
    await tick();
    document.getElementById(optionId(activeIndex))?.scrollIntoView({ block: "nearest" });
  }

  function choose(index: number): void {
    const model = matches[index];
    if (model === undefined) return;
    onselect(model);
    close();
    input.focus({ preventScroll: true });
  }

  function optionId(index: number): string {
    return `${id}-option-${encodeURIComponent(matches[index]?.id ?? String(index))}`;
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        void show().then(() => activate(event.key === "ArrowDown" ? 0 : -1));
      } else {
        const next = activeIndex < 0
          ? event.key === "ArrowDown" ? 0 : -1
          : activeIndex + (event.key === "ArrowDown" ? 1 : -1);
        void activate(next);
      }
      return;
    }
    if (event.key === "Enter" && open && activeIndex >= 0) {
      event.preventDefault();
      choose(activeIndex);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") close();
  }

  function pointerDown(event: PointerEvent): void {
    suppressPointerClick = false;
    pointerStart = { x: event.clientX, y: event.clientY };
    if (event.pointerType === "mouse") event.preventDefault();
  }

  function pointerMove(event: PointerEvent, index: number): void {
    if (event.pointerType === "mouse") {
      activeIndex = index;
      return;
    }
    if (pointerStart !== null && Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 6) {
      suppressPointerClick = true;
    }
  }

  function pointerClick(index: number): void {
    pointerStart = null;
    if (suppressPointerClick) {
      suppressPointerClick = false;
      return;
    }
    choose(index);
  }
</script>

<div class="agent-model-combobox" class:opens-above={opensAbove} bind:this={root}>
  <input
    bind:this={input}
    {id}
    type="text"
    role="combobox"
    aria-label={label}
    value={value}
    maxlength="128"
    required
    spellcheck="false"
    autocomplete="off"
    aria-autocomplete="list"
    aria-expanded={open}
    aria-controls={listboxId}
    aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
    aria-describedby={`${describedby} ${statusId}`}
    onfocus={() => void show()}
    onclick={() => { if (!open) void show(); }}
    oninput={(event) => { oninput(event.currentTarget.value); void show(); }}
    onkeydown={handleKeydown}
    onblur={(event) => {
      if (!root.contains(event.relatedTarget as Node | null)) close();
    }}
  />
  <span class="visually-hidden" id={statusId} role="status" aria-live="polite">{stateMessage}</span>
  <div class="agent-model-listbox" id={listboxId} role="listbox" bind:this={listbox} hidden={!open} style:max-height={`${popupMaxHeight}px`}>
      {#if matches.length > 0}
        {#each matches as model, index (model.id)}
          <div
            id={optionId(index)}
            role="option"
            tabindex="-1"
            aria-selected={index === activeIndex}
            class:active={index === activeIndex}
            onpointermove={(event) => pointerMove(event, index)}
            onpointerdown={pointerDown}
            onpointercancel={() => { pointerStart = null; suppressPointerClick = false; }}
            onclick={() => pointerClick(index)}
            onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") choose(index); }}
          >
            <strong>{model.id}</strong><span>{model.name}</span>
          </div>
        {/each}
      {:else}
        <p class="agent-model-empty">{stateMessage}</p>
      {/if}
  </div>
</div>
