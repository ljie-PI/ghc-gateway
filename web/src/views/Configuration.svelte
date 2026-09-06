<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, errorMessage, type AdminClient } from "../api.js";
  import type { RuntimeConfigKey } from "../../../src/config/schema.js";
  import type { AdminRuntimeConfig } from "../types.js";

  type RuntimeConfig = AdminRuntimeConfig["config"];
  interface ConfigField {
    readonly key: RuntimeConfigKey;
    readonly label: string;
    readonly description: string;
    readonly read: (config: RuntimeConfig) => number;
    readonly write: (config: RuntimeConfig, value: number) => void;
  }

  let { client }: { client: AdminClient } = $props();
  let data: AdminRuntimeConfig | null = $state(null);
  let loading = $state(true);
  let saving = $state(false);
  let failure = $state("");
  let message = $state("");

  const fields = [
    field("limits.requestBodyBytes", "Request body", "Maximum inbound JSON bytes", (config) => config.limits.requestBodyBytes, (config, value) => config.limits.requestBodyBytes = value),
    field("limits.sseEventBytes", "SSE event", "Maximum upstream event bytes", (config) => config.limits.sseEventBytes, (config, value) => config.limits.sseEventBytes = value),
    field("limits.nonstreamBodyBytes", "Non-stream body", "Maximum buffered upstream bytes", (config) => config.limits.nonstreamBodyBytes, (config, value) => config.limits.nonstreamBodyBytes = value),
    field("limits.accumulatorBytes", "Accumulator", "Per-request protocol state", (config) => config.limits.accumulatorBytes, (config, value) => config.limits.accumulatorBytes = value),
    field("admission.activeMax", "Active requests", "Concurrent inference permits", (config) => config.admission.activeMax, (config, value) => config.admission.activeMax = value),
    field("admission.queueMax", "Queued requests", "Waiting request capacity", (config) => config.admission.queueMax, (config, value) => config.admission.queueMax = value),
    field("timeouts.queueMs", "Queue wait", "Admission deadline", (config) => config.timeouts.queueMs, (config, value) => config.timeouts.queueMs = value),
    field("timeouts.connectMs", "Connect", "Upstream connection deadline", (config) => config.timeouts.connectMs, (config, value) => config.timeouts.connectMs = value),
    field("timeouts.firstByteMs", "First byte", "Upstream response deadline", (config) => config.timeouts.firstByteMs, (config, value) => config.timeouts.firstByteMs = value),
    field("timeouts.streamIdleMs", "Stream idle", "Inter-event deadline", (config) => config.timeouts.streamIdleMs, (config, value) => config.timeouts.streamIdleMs = value),
    field("timeouts.totalMs", "Total request", "End-to-end deadline", (config) => config.timeouts.totalMs, (config, value) => config.timeouts.totalMs = value),
    field("accounts.maxAuthenticated", "Accounts", "Authenticated account capacity", (config) => config.accounts.maxAuthenticated, (config, value) => config.accounts.maxAuthenticated = value),
    field("history.ttlDays", "History TTL", "Responses bridge retention", (config) => config.history.ttlDays, (config, value) => config.history.ttlDays = value),
    field("usage.retentionDays", "Usage retention", "Hourly aggregate retention", (config) => config.usage.retentionDays, (config, value) => config.usage.retentionDays = value),
    field("events.retentionDays", "Event retention", "Operational event retention", (config) => config.events.retentionDays, (config, value) => config.events.retentionDays = value),
  ] satisfies readonly ConfigField[];
  type MissingConfigKey = Exclude<RuntimeConfigKey, typeof fields[number]["key"]>;
  const allConfigKeysCovered: MissingConfigKey extends never ? true : never = true;
  void allConfigKeysCovered;
  const groups = ["limits", "admission", "timeouts", "accounts", "history", "usage", "events"] as const;

  onMount(load);

  async function load(): Promise<void> {
    loading = true;
    failure = "";
    try {
      data = await client.config();
    } catch (error: unknown) {
      failure = errorMessage(error);
    } finally {
      loading = false;
    }
  }

  function field(
    key: RuntimeConfigKey,
    label: string,
    description: string,
    read: ConfigField["read"],
    write: ConfigField["write"],
  ): ConfigField {
    return { key, label, description, read, write };
  }

  function value(configField: ConfigField): number {
    return data === null ? 0 : configField.read(data.config);
  }

  function update(configField: ConfigField, next: string): void {
    if (data !== null) configField.write(data.config, Number(next));
  }

  async function save(): Promise<void> {
    if (!data) return;
    saving = true;
    failure = "";
    message = "";
    try {
      data = await client.saveConfig(data);
      message = "Runtime configuration applied atomically.";
    } catch (error: unknown) {
      const notice = errorMessage(error);
      if (error instanceof ApiError && error.status === 409) await load();
      failure = notice;
    } finally {
      saving = false;
    }
  }
</script>

<header class="page-head">
  <div>
    <p class="eyebrow">[04] LOCAL ADMINISTRATION</p>
    <h1 tabindex="-1">Configuration</h1>
    <p>Revision-safe limits, admission and retention controls.</p>
  </div>
  {#if data}<span class="revision">REVISION {data.revision}</span>{/if}
</header>

{#if message}
  <p class="notice success" role="status">{message}</p>
{/if}
{#if failure}
  <p class="notice error" role="alert">{failure}</p>
{/if}

{#if loading}
  <p class="loading-line" aria-busy="true">Loading runtime configuration...</p>
{:else if data}
  <form class="config-form" onsubmit={(event) => { event.preventDefault(); void save(); }}>
    {#each groups as group (group)}
      <fieldset>
        <legend>{group} settings</legend>
        <div class="config-grid">
          {#each fields.filter((configField) => configField.key.startsWith(`${group}.`)) as configField (configField.key)}
            <label>
              <span><strong>{configField.label}</strong><small>{configField.description}</small></span>
              <input
                type="number"
                value={value(configField)}
                min={data.ranges[configField.key]?.min}
                max={data.ranges[configField.key]?.max}
                required
                oninput={(event) => update(configField, event.currentTarget.value)}
              />
              <small class="range">
                {data.ranges[configField.key]?.min.toLocaleString()}–{data.ranges[configField.key]?.max.toLocaleString()}
                {data.ranges[configField.key]?.unit}
              </small>
            </label>
          {/each}
        </div>
      </fieldset>
    {/each}
    <div class="sticky-save">
      <p>All fields are required. Invalid candidates leave the active snapshot unchanged.</p>
      <button class="primary" disabled={saving}>{saving ? "Applying..." : "Apply configuration"}</button>
    </div>
  </form>
{/if}
