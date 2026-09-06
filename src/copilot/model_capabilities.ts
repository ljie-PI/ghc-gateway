import type { ModelInfoLookup } from "./model_catalog.js";

export type NativeModelProtocol = "chat" | "messages" | "responses";
export type ChatOutputTokenField = "max_tokens" | "max_completion_tokens";
export type CapabilityFieldState = "missing" | "value" | "malformed";
export type CapabilitySource = "admin_override" | "live" | "builtin" | "unknown";

export class ModelCapabilityUnavailableError extends Error {
  constructor() {
    super("model native protocol capability is not configured");
    this.name = "ModelCapabilityUnavailableError";
  }
}

export function isModelCapabilityUnavailable(error: unknown): error is ModelCapabilityUnavailableError {
  return error instanceof ModelCapabilityUnavailableError;
}

export function safeCapabilityFailureMessage(cause: unknown, fallback: string): string {
  return isModelCapabilityUnavailable(cause)
    ? "model native protocol capability is not configured"
    : fallback;
}

export interface DeclaredField<T> {
  readonly state: CapabilityFieldState;
  readonly value?: T;
}

export interface DeclaredModelCapabilities {
  readonly protocols: DeclaredField<readonly NativeModelProtocol[]>;
  readonly maxInputTokens: DeclaredField<number>;
  readonly maxOutputTokens: DeclaredField<number>;
  readonly defaultOutputTokens: DeclaredField<number>;
  readonly chatOutputTokenField: DeclaredField<ChatOutputTokenField>;
}

export interface EffectiveCapabilityField<T> {
  readonly value: T | null;
  readonly source: CapabilitySource;
  readonly conflict: boolean;
  readonly liveState: CapabilityFieldState;
}

export interface EffectiveOutputDefault {
  readonly configuration: EffectiveCapabilityField<number>;
  readonly effective: number;
  readonly source: CapabilitySource | "known_ceiling" | "unknown_fallback";
  readonly valid: boolean;
}

export interface ModelCapabilityProfile {
  readonly chatOutputTokenField: EffectiveCapabilityField<ChatOutputTokenField>;
}

export interface ModelCapabilityOverrideValue {
  readonly enabled: boolean;
  readonly protocols?: readonly NativeModelProtocol[];
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly defaultOutputTokens?: number;
  readonly chatOutputTokenField?: ChatOutputTokenField;
}

export interface BuiltinModelCapabilities {
  readonly revision: string;
  readonly capabilities: DeclaredModelCapabilities;
}

export interface BuiltinModelCapabilityLookup {
  get(modelId: string): BuiltinModelCapabilities | null;
}

export const UNKNOWN_DECLARATIONS: DeclaredModelCapabilities = Object.freeze({
  protocols: missing<readonly NativeModelProtocol[]>(),
  maxInputTokens: missing<number>(),
  maxOutputTokens: missing<number>(),
  defaultOutputTokens: missing<number>(),
  chatOutputTokenField: missing<ChatOutputTokenField>(),
});

export function parseLiveModelCapabilities(record: Readonly<Record<string, unknown>>): DeclaredModelCapabilities {
  return Object.freeze({
    protocols: parseLocations(record, [
      ["supported_endpoints"],
      ["model_info", "supported_endpoints"],
      ["capabilities", "supported_endpoints"],
    ], parseEndpointProtocols),
    maxInputTokens: parseLocations(record, [
      ["max_input_tokens"],
      ["model_info", "max_input_tokens"],
      ["capabilities", "max_input_tokens"],
      ["capabilities", "limits", "max_prompt_tokens"],
      ["capabilities", "limits", "max_context_window_tokens"],
    ], parsePositiveInteger),
    maxOutputTokens: parseLocations(record, [
      ["max_output_tokens"],
      ["model_info", "max_output_tokens"],
      ["capabilities", "max_output_tokens"],
      ["capabilities", "limits", "max_output_tokens"],
    ], parsePositiveInteger),
    defaultOutputTokens: parseLocations(record, [
      ["default_output_tokens"],
      ["model_info", "default_output_tokens"],
      ["capabilities", "default_output_tokens"],
    ], parsePositiveInteger),
    chatOutputTokenField: parseLocations(record, [
      ["chat_output_token_field"],
      ["model_info", "chat_output_token_field"],
      ["capabilities", "chat_output_token_field"],
    ], parseChatOutputTokenField),
  });
}

export function builtinCapabilitiesFromModelInfo(
  lookup: ModelInfoLookup,
  modelId: string,
  revision: string,
): BuiltinModelCapabilities | null {
  let raw: ReturnType<ModelInfoLookup["get"]>;
  try {
    raw = lookup.get(modelId);
  } catch {
    return null;
  }
  if (raw === null) {
    return null;
  }
  const record: Record<string, unknown> = {
    ...(Object.hasOwn(raw, "max_input_tokens") ? { max_input_tokens: raw.max_input_tokens } : {}),
    ...(Object.hasOwn(raw, "max_output_tokens") ? { max_output_tokens: raw.max_output_tokens } : {}),
    ...(Object.hasOwn(raw, "supported_endpoints") ? { supported_endpoints: raw.supported_endpoints } : {}),
    ...("default_output_tokens" in raw ? { default_output_tokens: raw.default_output_tokens } : {}),
    ...("chat_output_token_field" in raw ? { chat_output_token_field: raw.chat_output_token_field } : {}),
  };
  return {
    revision,
    capabilities: Object.freeze({
      protocols: Object.hasOwn(record, "supported_endpoints")
        ? parseEndpointProtocols(record.supported_endpoints)
        : missing<readonly NativeModelProtocol[]>(),
      maxInputTokens: Object.hasOwn(record, "max_input_tokens")
        ? parsePositiveInteger(record.max_input_tokens)
        : missing<number>(),
      maxOutputTokens: Object.hasOwn(record, "max_output_tokens")
        ? parsePositiveInteger(record.max_output_tokens)
        : missing<number>(),
      defaultOutputTokens: Object.hasOwn(record, "default_output_tokens")
        ? parsePositiveInteger(record.default_output_tokens)
        : missing<number>(),
      chatOutputTokenField: Object.hasOwn(record, "chat_output_token_field")
        ? parseChatOutputTokenField(record.chat_output_token_field)
        : missing<ChatOutputTokenField>(),
    }),
  };
}

export function effectiveField<T>(
  overrideValue: T | undefined,
  live: DeclaredField<T>,
  builtin: DeclaredField<T>,
  equals: (left: T, right: T) => boolean = Object.is,
): EffectiveCapabilityField<T> {
  if (overrideValue !== undefined) {
    return Object.freeze({
      value: overrideValue,
      source: "admin_override",
      conflict: differsFromLower(overrideValue, live, builtin, equals),
      liveState: live.state,
    });
  }
  if (live.state === "value") {
    return Object.freeze({
      value: live.value as T,
      source: "live",
      conflict: builtin.state === "value" && !equals(live.value as T, builtin.value as T),
      liveState: live.state,
    });
  }
  if (live.state === "malformed") {
    return Object.freeze({ value: null, source: "unknown", conflict: false, liveState: live.state });
  }
  if (builtin.state === "value") {
    return Object.freeze({
      value: builtin.value as T,
      source: "builtin",
      conflict: false,
      liveState: live.state,
    });
  }
  return Object.freeze({ value: null, source: "unknown", conflict: false, liveState: live.state });
}

export function resolveDefaultOutputTokens(
  configuration: EffectiveCapabilityField<number>,
  maxOutputTokens: number | null,
): EffectiveOutputDefault {
  if (configuration.value !== null) {
    return Object.freeze({
      configuration,
      effective: configuration.value,
      source: configuration.source,
      valid: maxOutputTokens === null || configuration.value <= maxOutputTokens,
    });
  }
  if (maxOutputTokens !== null) {
    return Object.freeze({
      configuration,
      effective: Math.min(8192, maxOutputTokens),
      source: "known_ceiling",
      valid: true,
    });
  }
  return Object.freeze({ configuration, effective: 4096, source: "unknown_fallback", valid: true });
}

export function chooseOutputTokenBudget(
  explicit: unknown,
  fallback: Readonly<EffectiveOutputDefault>,
): number {
  if (explicit !== undefined) {
    if (typeof explicit !== "number" || !Number.isSafeInteger(explicit) || explicit <= 0) {
      throw new TypeError("invalid explicit output token budget");
    }
    return explicit;
  }
  if (!fallback.valid) {
    throw new TypeError("configured output token default exceeds model ceiling");
  }
  return fallback.effective;
}

export function sameProtocols(
  left: readonly NativeModelProtocol[],
  right: readonly NativeModelProtocol[],
): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function parseLocations<T>(
  record: Readonly<Record<string, unknown>>,
  paths: readonly (readonly string[])[],
  parse: (value: unknown) => DeclaredField<T>,
): DeclaredField<T> {
  const values: unknown[] = [];
  let malformedContainer = false;
  for (const path of paths) {
    let current: unknown = record;
    for (let index = 0; index < path.length; index += 1) {
      const key = path[index];
      if (key === undefined || current === null || typeof current !== "object" || Array.isArray(current)) {
        malformedContainer = true;
        break;
      }
      const object = current as Readonly<Record<string, unknown>>;
      if (!Object.hasOwn(object, key)) {
        break;
      }
      current = object[key];
      if (index === path.length - 1) {
        values.push(current);
      }
    }
  }
  if (malformedContainer) {
    return malformed();
  }
  if (values.length === 0) {
    return missing();
  }
  const parsed = values.map(parse);
  if (parsed.some((field) => field.state !== "value")) {
    return malformed();
  }
  const first = parsed[0]?.value;
  if (first === undefined) {
    return malformed();
  }
  const serialized = JSON.stringify(first);
  return parsed.every((field) => JSON.stringify(field.value) === serialized)
    ? value(first)
    : malformed();
}

function parseEndpointProtocols(input: unknown): DeclaredField<readonly NativeModelProtocol[]> {
  if (!Array.isArray(input) || input.some((item) => typeof item !== "string")) {
    return malformed();
  }
  const protocols: NativeModelProtocol[] = [];
  for (const endpoint of input) {
    const protocol = endpointProtocol(endpoint);
    if (protocol !== null && !protocols.includes(protocol)) {
      protocols.push(protocol);
    }
  }
  return value(Object.freeze(
    (["chat", "messages", "responses"] as const).filter((protocol) => protocols.includes(protocol)),
  ));
}

function endpointProtocol(endpoint: string): NativeModelProtocol | null {
  switch (endpoint.trim().toLowerCase().replace(/\/+$/u, "")) {
  case "/chat/completions":
  case "/v1/chat/completions":
    return "chat";
  case "/messages":
  case "/v1/messages":
    return "messages";
  case "/responses":
  case "/v1/responses":
    return "responses";
  default:
    return null;
  }
}

function parsePositiveInteger(input: unknown): DeclaredField<number> {
  if (typeof input === "number" && Number.isSafeInteger(input) && input > 0) {
    return value(input);
  }
  if (typeof input === "string" && /^[1-9]\d*$/u.test(input)) {
    const parsed = Number(input);
    if (Number.isSafeInteger(parsed)) {
      return value(parsed);
    }
  }
  return malformed();
}

function parseChatOutputTokenField(input: unknown): DeclaredField<ChatOutputTokenField> {
  return input === "max_tokens" || input === "max_completion_tokens"
    ? value(input)
    : malformed();
}

function differsFromLower<T>(
  overrideValue: T,
  live: DeclaredField<T>,
  builtin: DeclaredField<T>,
  equals: (left: T, right: T) => boolean,
): boolean {
  return (live.state === "value" && !equals(overrideValue, live.value as T))
    || (live.state === "missing" && builtin.state === "value" && !equals(overrideValue, builtin.value as T));
}

function missing<T>(): DeclaredField<T> {
  return Object.freeze({ state: "missing" });
}

function malformed<T>(): DeclaredField<T> {
  return Object.freeze({ state: "malformed" });
}

function value<T>(input: T): DeclaredField<T> {
  return Object.freeze({ state: "value", value: input });
}
