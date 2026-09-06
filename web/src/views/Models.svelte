<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, errorMessage, type AdminClient } from "../api.js";
  import type { AdminAccounts, AdminModels } from "../types.js";

  type ModelItem = AdminModels["items"][number];
  type Protocol = NonNullable<ModelItem["protocols"]>[number];
  type Editor = {
    enabled: boolean;
    protocols: Protocol[];
    maxInputTokens: string;
    maxOutputTokens: string;
    defaultOutputTokens: string;
    chatOutputTokenField: "" | "max_tokens" | "max_completion_tokens";
  };

  let { client }: { client: AdminClient } = $props();
  let accounts: AdminAccounts | null = $state(null);
  let data: AdminModels | null = $state(null);
  let accountId = $state("");
  let loading = $state(true);
  let busy = $state("");
  let failure = $state("");
  let message = $state("");
  let editors = $state<Record<string, Editor>>({});
  let newModelId = $state("");

  onMount(async () => {
    try {
      accounts = await client.accounts();
      accountId = accounts.defaultAccountId
        ?? accounts.items.find((account) => account.state === "active")?.accountId
        ?? "";
      await load();
    } catch (error: unknown) {
      failure = errorMessage(error);
      loading = false;
    }
  });

  async function load(preserveFailure = false): Promise<void> {
    if (!accountId) {
      loading = false;
      data = null;
      return;
    }
    loading = true;
    if (!preserveFailure) failure = "";
    try {
      data = await client.models(accountId);
      syncEditors();
    } catch (error: unknown) {
      failure = errorMessage(error);
    } finally {
      loading = false;
    }
  }

  function syncEditors(): void {
    const next: Record<string, Editor> = {};
    for (const model of data?.items ?? []) {
      const override = model.override;
      next[model.id] = {
        enabled: override?.enabled ?? model.enabled,
        protocols: [...(override?.protocols ?? model.protocols ?? [])],
        maxInputTokens: numberText(override?.maxInputTokens),
        maxOutputTokens: numberText(override?.maxOutputTokens),
        defaultOutputTokens: numberText(override?.defaultOutputTokens),
        chatOutputTokenField: override?.chatOutputTokenField ?? "",
      };
    }
    editors = next;
  }

  async function refresh(): Promise<void> {
    if (!accountId) return;
    busy = "refresh";
    failure = "";
    try {
      data = await client.refreshModels(accountId);
      syncEditors();
      message = data.preferredModel?.validity === "invalid"
        ? "Catalog refreshed. Your previous preference is no longer available."
        : "Catalog refreshed.";
    } catch (error: unknown) {
      failure = errorMessage(error);
    } finally {
      busy = "";
    }
  }

  async function prefer(id: string): Promise<void> {
    if (!data) return;
    busy = `prefer:${id}`;
    failure = "";
    try {
      await client.preferModel(data.accountId, id, data.preferredModel?.revision ?? 0);
      message = `${id} is now preferred.`;
      await load();
    } catch (error: unknown) {
      failure = errorMessage(error);
      if (error instanceof ApiError && error.status === 409) await load(true);
    } finally {
      busy = "";
    }
  }

  async function save(model: ModelItem): Promise<void> {
    const editor = editors[model.id];
    if (!data || editor === undefined) return;
    busy = `save:${model.id}`;
    failure = "";
    try {
      data = await client.setModelCapabilities(
        data.accountId,
        model.id,
        model.overrideRevision,
        {
          enabled: editor.enabled,
          protocols: editor.protocols,
          ...optionalNumber("maxInputTokens", editor.maxInputTokens),
          ...optionalNumber("maxOutputTokens", editor.maxOutputTokens),
          ...optionalNumber("defaultOutputTokens", editor.defaultOutputTokens),
          ...(editor.chatOutputTokenField === "" ? {} : {
            chatOutputTokenField: editor.chatOutputTokenField,
          }),
        },
      );
      syncEditors();
      message = `${model.id} capability override saved.`;
    } catch (error: unknown) {
      failure = errorMessage(error);
      if (error instanceof ApiError && error.status === 409) await load(true);
    } finally {
      busy = "";
    }
  }

  async function reset(model: ModelItem): Promise<void> {
    if (!data) return;
    busy = `reset:${model.id}`;
    failure = "";
    try {
      data = await client.resetModelCapabilities(data.accountId, model.id, model.overrideRevision);
      syncEditors();
      message = `${model.id} capability override reset.`;
    } catch (error: unknown) {
      failure = errorMessage(error);
      if (error instanceof ApiError && error.status === 409) await load(true);
    } finally {
      busy = "";
    }
  }

  async function addConfiguredModel(): Promise<void> {
    if (!data || !newModelId) return;
    busy = "add";
    failure = "";
    try {
      data = await client.setModelCapabilities(
        data.accountId,
        newModelId,
        data.overrideRevisions[newModelId] ?? 0,
        {
        enabled: true,
        protocols: [],
        },
      );
      message = `${newModelId} added as configured and unverified.`;
      newModelId = "";
      syncEditors();
    } catch (error: unknown) {
      failure = errorMessage(error);
    } finally {
      busy = "";
    }
  }

  function toggleProtocol(modelId: string, protocol: Protocol, checked: boolean): void {
    const editor = editors[modelId];
    if (editor === undefined) return;
    editor.protocols = checked
      ? [...new Set([...editor.protocols, protocol])]
      : editor.protocols.filter((value) => value !== protocol);
  }

  function optionalNumber<Key extends "maxInputTokens" | "maxOutputTokens" | "defaultOutputTokens">(
    key: Key,
    text: string,
  ): Partial<Record<Key, number>> {
    return text === "" ? {} : { [key]: Number(text) } as Partial<Record<Key, number>>;
  }

  function numberText(value: number | undefined): string {
    return value === undefined ? "" : String(value);
  }
</script>

<header class="page-head">
  <div>
    <p class="eyebrow">CATALOG CONTROL</p>
    <h1 tabindex="-1">Models</h1>
    <p>Inspect native capabilities and explicitly configure each account's models.</p>
  </div>
  <button class="primary" onclick={refresh} disabled={!accountId || busy === "refresh"}>
    {busy === "refresh" ? "Refreshing..." : "Refresh catalog"}
  </button>
</header>

<section class="toolbar">
  <label for="model-account">Account</label>
  <select id="model-account" bind:value={accountId} onchange={() => void load()}>
    {#each accounts?.items.filter((account) => account.state === "active") ?? [] as account (account.accountId)}
      <option value={account.accountId}>{account.login ?? account.host} · {account.host}</option>
    {/each}
  </select>
  {#if data}
    <span class="subtle">
      Generation {data.catalogGeneration} · credential {data.credentialGeneration} · fetched {new Date(data.fetchedAt).toLocaleString()}
    </span>
  {/if}
</section>

{#if data}
  <section class="toolbar" aria-label="Add configured model">
    <label for="configured-model-id">Model ID</label>
    <input id="configured-model-id" bind:value={newModelId} maxlength="128" placeholder="exact-model-id" />
    <button onclick={addConfiguredModel} disabled={!newModelId || busy === "add"}>
      {busy === "add" ? "Adding..." : "Add configured model"}
    </button>
  </section>
{/if}

{#if message}<p class="notice success" role="status">{message}</p>{/if}
{#if failure}<p class="notice error" role="alert">{failure}</p>{/if}

{#if data?.preferredModel?.validity === "invalid"}
  <section class="notice warning" role="alert">
    <h2>Preferred model unavailable</h2>
    <p>Select an enabled visible model below. The gateway will not silently substitute one.</p>
  </section>
{/if}

{#if loading}
  <p class="loading-line" aria-busy="true">Loading model catalog...</p>
{:else if !accountId}
  <section class="empty">
    <span>--</span>
    <h2>No active account</h2>
    <p>Connect an account before requesting a model catalog.</p>
  </section>
{:else if data?.items.length === 0}
  <section class="empty">
    <span>00</span>
    <h2>Catalog is empty</h2>
    <p>The account returned no visible models. Add an exact model ID or refresh discovery.</p>
  </section>
{:else if data}
  <section class="model-grid" aria-label="Account models">
    {#each data.items as model (model.id)}
      {@const editor = editors[model.id]}
      <article class:preferred={data.preferredModel?.modelId === model.id && data.preferredModel.validity === "valid"}>
        <div class="model-vendor">{model.vendor}</div>
        <h2>{model.name}</h2>
        <code>{model.id}</code>
        <p class="subtle">
          {model.discovered ? "Discovered" : "Configured / unverified"} ·
          {model.enabled ? "enabled" : "disabled"} · revision {model.overrideRevision}
        </p>
        <dl>
          <div><dt>Native HTTP protocols</dt><dd>{model.protocols?.join(", ") || (model.protocols === null ? "Unknown" : "None")}</dd></div>
          <div><dt>Protocol source</dt><dd>{model.protocolsSource}{model.protocolsConflict ? " · conflict" : ""}</dd></div>
          <div><dt>Live declaration</dt><dd>{model.protocolsLiveState}</dd></div>
          <div><dt>Input window</dt><dd>{model.maxInputTokens?.toLocaleString() ?? "Unknown"} · {model.maxInputTokensSource}{model.maxInputTokensConflict ? " · conflict" : ""} · live {model.maxInputTokensLiveState}</dd></div>
          <div><dt>Output window</dt><dd>{model.maxOutputTokens?.toLocaleString() ?? "Unknown"} · {model.maxOutputTokensSource}{model.maxOutputTokensConflict ? " · conflict" : ""} · live {model.maxOutputTokensLiveState}</dd></div>
          <div><dt>Default output</dt><dd>{model.defaultOutputTokens.effective.toLocaleString()} · {model.defaultOutputTokens.source}{model.defaultOutputTokens.conflict ? " · conflict" : ""}{model.defaultOutputTokens.valid ? "" : " · invalid for current ceiling"} · live {model.defaultOutputTokens.liveState}</dd></div>
          <div><dt>Chat budget field</dt><dd>{model.chatOutputTokenField ?? "Unknown"} · {model.chatOutputTokenFieldSource}{model.chatOutputTokenFieldConflict ? " · conflict" : ""} · live {model.chatOutputTokenFieldLiveState}</dd></div>
          <div><dt>Built-in revision</dt><dd>{model.builtinRevision ?? "None"}</dd></div>
        </dl>

        {#if editor}
          <label>
            <input type="checkbox" bind:checked={editor.enabled} />
            Enabled and visible
          </label>
          <fieldset>
            <legend>Native HTTP protocols</legend>
            {#each ["chat", "messages", "responses"] as protocol (protocol)}
              <label>
                <input
                  type="checkbox"
                  checked={editor.protocols.includes(protocol as Protocol)}
                  onchange={(event) => toggleProtocol(model.id, protocol as Protocol, event.currentTarget.checked)}
                />
                {protocol}
              </label>
            {/each}
          </fieldset>
          <label for={`input-limit-${model.id}`}>Override input ceiling</label>
          <input id={`input-limit-${model.id}`} type="number" min="1" bind:value={editor.maxInputTokens} placeholder="use live/builtin" />
          <label for={`output-limit-${model.id}`}>Override output ceiling</label>
          <input id={`output-limit-${model.id}`} type="number" min="1" bind:value={editor.maxOutputTokens} placeholder="use live/builtin" />
          <label for={`default-output-${model.id}`}>Default output tokens</label>
          <input id={`default-output-${model.id}`} type="number" min="1" bind:value={editor.defaultOutputTokens} placeholder="automatic policy" />
          <label for={`chat-field-${model.id}`}>Chat output token field</label>
          <select id={`chat-field-${model.id}`} bind:value={editor.chatOutputTokenField}>
            <option value="">Use live/builtin/unknown</option>
            <option value="max_tokens">max_tokens</option>
            <option value="max_completion_tokens">max_completion_tokens</option>
          </select>
          <button onclick={() => save(model)} disabled={busy === `save:${model.id}`}>
            {busy === `save:${model.id}` ? "Saving..." : "Save capability override"}
          </button>
          {#if model.configured}
            <button onclick={() => reset(model)} disabled={busy === `reset:${model.id}`}>
              {busy === `reset:${model.id}` ? "Resetting..." : "Reset override"}
            </button>
          {/if}
        {/if}

        {#if model.visible}
          <button
            onclick={() => prefer(model.id)}
            disabled={busy === `prefer:${model.id}` || (data.preferredModel?.modelId === model.id && data.preferredModel.validity === "valid")}
          >
            {data.preferredModel?.modelId === model.id && data.preferredModel.validity === "valid" ? "Preferred" : "Set preferred"}
          </button>
        {/if}
      </article>
    {/each}
  </section>
{/if}
