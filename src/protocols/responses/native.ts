import { ChatSseError } from "../../copilot/chat_sse.js";
import type { BoundCopilot } from "../../copilot/backend.js";
import { GatewayFailureError } from "../../gateway/failures.js";
import { boundedCleanup } from "../../gateway/stream_execution.js";
import {
  isWireJsonArray,
  isWireJsonNumber,
  isWireJsonObject,
  memberValues,
  parseWireJson,
  serializeWireJson,
  type WireJson,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import type {
  NativeResponsesUpstreamRequest,
  UpstreamByteResponse,
  UpstreamByteStream,
} from "../../copilot/upstream_types.js";
import type { ProtocolPerformanceObserver } from "../../telemetry/runtime.js";
import type { NativeResponsesPlan } from "./planner.js";
import { encodeResponsesSseEvent } from "./wire.js";

export interface NativeResponsesRequestOptions {
  readonly requestId: string;
  readonly nonstreamBodyBytes: number;
  readonly connectTimeoutMs: number;
  readonly firstByteTimeoutMs: number;
  readonly signal: AbortSignal;
}

interface ParsedSseEvent {
  readonly eventName?: string;
  readonly data: string;
}

const TERMINAL_EVENTS = new Set(["response.completed", "response.failed", "response.incomplete", "error"]);

export function nativeResponsesUpstreamRequest(
  plan: Readonly<NativeResponsesPlan>,
  options: Readonly<NativeResponsesRequestOptions>,
): NativeResponsesUpstreamRequest {
  return {
    body: serializeNativeResponsesRequest(plan),
    hasVisionInput: hasNativeVisionInput(plan.originalRequest.input),
    initiator: nativeInitiator(plan.originalRequest.input),
    requestId: options.requestId,
    nonstreamBodyBytes: options.nonstreamBodyBytes,
    connectTimeoutMs: options.connectTimeoutMs,
    firstByteTimeoutMs: options.firstByteTimeoutMs,
    signal: options.signal,
  };
}

export async function completeNativeResponses(
  bound: BoundCopilot,
  plan: Readonly<NativeResponsesPlan>,
  options: Readonly<NativeResponsesRequestOptions>,
): Promise<UpstreamByteResponse> {
  const response = await bound.completeResponses(nativeResponsesUpstreamRequest(plan, options));
  return {
    status: response.status,
    headers: response.headers,
    body: validatedNativeResponsesBody(response, options.nonstreamBodyBytes),
  };
}

export async function openNativeResponsesStream(
  bound: BoundCopilot,
  plan: Readonly<NativeResponsesPlan>,
  options: Readonly<NativeResponsesRequestOptions>,
): Promise<UpstreamByteStream> {
  const upstream = await bound.openResponsesStream(nativeResponsesUpstreamRequest(plan, options));
  if (upstream.status >= 200 && upstream.status < 300 && !isEventStream(upstream.headers)) {
    await boundedCleanup(upstream.cancel());
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  return upstream;
}

export function serializeNativeResponsesRequest(plan: Readonly<NativeResponsesPlan>): Uint8Array {
  let replaced = false;
  const members = plan.originalRequest.body.members.map((member) => {
    if (member.key !== "model") {
      return member;
    }
    replaced = true;
    return { key: member.key, value: plan.resolvedModel.upstreamModel };
  });
  if (!replaced) {
    members.push({ key: "model", value: plan.resolvedModel.upstreamModel });
  }
  return serializeWireJson({ kind: "object", members });
}

export function validatedNativeResponsesBody(
  response: Readonly<UpstreamByteResponse>,
  maxBytes: number,
): Uint8Array {
  if (response.status < 200 || response.status >= 300) {
    return response.body;
  }
  try {
    const parsed = parseWireJson(response.body, { maxBytes, maxDepth: 64 });
    if (!isWireJsonObject(parsed)) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    return response.body;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
}

export async function* normalizeNativeResponsesStream(
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes: number,
  observeEvent?: (event: Readonly<WireJsonObject>) => void,
  performanceObserver?: ProtocolPerformanceObserver,
): AsyncIterable<Uint8Array> {
  const stableIds = new Map<number, string>();
  let terminal = false;
  for await (const event of parseResponsesSse(bytes, eventLimitBytes)) {
    const payload = parseResponsesEventData(event);
    const type = stringMember(payload, "type");
    if (type === undefined || type.length === 0 || (event.eventName !== undefined && event.eventName !== type)) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    const encoded = measureEvent(performanceObserver, () => {
      const normalized = normalizeNativeResponsesEvent(payload, stableIds, type);
      try {
        observeEvent?.(normalized);
      } catch (_error: unknown) {
        // Side observation cannot affect native Responses bytes.
      }
      return encodeResponsesSseEvent(normalized);
    });
    yield encoded;
    if (TERMINAL_EVENTS.has(type)) {
      terminal = true;
      return;
    }
  }
  if (!terminal) {
    throw new GatewayFailureError({
      kind: "upstream_stream_truncated",
      source: "parser",
      phase: "stream",
    });
  }
}

function measureEvent<T>(observer: ProtocolPerformanceObserver | undefined, work: () => T): T {
  return observer === undefined ? work() : observer.measure("event", work);
}

function normalizeNativeResponsesEvent(
  event: WireJsonObject,
  stableIds: Map<number, string>,
  type: string,
): WireJsonObject {
  const outputIndex = integerMember(event, "output_index");
  if (type === "response.output_item.added" && outputIndex !== undefined) {
    const item = objectMember(event, "item");
    const id = item === undefined ? undefined : stringMember(item, "id");
    if (id !== undefined) {
      stableIds.set(outputIndex, id);
    }
  }
  const stableId = outputIndex === undefined ? undefined : stableIds.get(outputIndex);
  if (stableId === undefined) {
    return event;
  }
  let next = replaceExistingStringMember(event, "item_id", stableId);
  if (type === "response.output_item.done") {
    const item = objectMember(next, "item");
    if (item !== undefined) {
      next = replaceMember(next, "item", replaceExistingStringMember(item, "id", stableId));
    }
  }
  return next;
}

async function* parseResponsesSse(
  bytes: AsyncIterable<Uint8Array>,
  eventLimitBytes: number,
): AsyncIterable<ParsedSseEvent> {
  let pending = "";
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    for await (const chunk of bytes) {
      pending += decoder.decode(chunk, { stream: true });
      for (;;) {
        const normalized = pending.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
        const boundary = normalized.indexOf("\n\n");
        if (boundary === -1) {
          if (new TextEncoder().encode(normalized).byteLength > eventLimitBytes) {
            throw new ChatSseError("event_too_large", "SSE event exceeds limit");
          }
          pending = normalized;
          break;
        }
        const raw = normalized.slice(0, boundary);
        if (new TextEncoder().encode(`${raw}\n\n`).byteLength > eventLimitBytes) {
          throw new ChatSseError("event_too_large", "SSE event exceeds limit");
        }
        pending = normalized.slice(boundary + 2);
        const parsed = parseSseRecord(raw);
        if (parsed !== undefined) {
          yield parsed;
        }
      }
    }
    pending += decoder.decode();
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new GatewayFailureError({
        kind: "aborted",
        source: "parser",
        phase: "stream",
      });
    }
    if (error instanceof ChatSseError) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
    }
    throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
  if (pending.length > 0) {
    throw new GatewayFailureError({
      kind: "upstream_stream_truncated",
      source: "parser",
      phase: "stream",
    });
  }
}

function parseSseRecord(raw: string): ParsedSseEvent | undefined {
  let eventName: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const name = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (name === "event") {
      eventName = value;
    } else if (name === "data") {
      data.push(value);
    }
  }
  if (data.length === 0) {
    return undefined;
  }
  const joined = data.join("\n");
  if (joined === "[DONE]") {
    throw new GatewayFailureError({ kind: "invalid_upstream_response" });
  }
  return eventName === undefined ? { data: joined } : { eventName, data: joined };
}

function parseResponsesEventData(event: ParsedSseEvent): WireJsonObject {
  try {
    const data = new TextEncoder().encode(event.data);
    const parsed = parseWireJson(data, { maxBytes: Math.max(data.byteLength, 1), maxDepth: 64 });
    if (!isWireJsonObject(parsed)) {
      throw new GatewayFailureError({ kind: "invalid_upstream_response" });
    }
    return parsed;
  } catch (error: unknown) {
    if (error instanceof GatewayFailureError) {
      throw error;
    }
    throw new GatewayFailureError({ kind: "invalid_upstream_response", cause: error });
  }
}

function hasNativeVisionInput(value: WireJson | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  if (isWireJsonObject(value)) {
    if (memberValues(value, "type")[0] === "input_image") {
      return true;
    }
    return value.members.some((member) => hasNativeVisionInput(member.value));
  }
  if (isWireJsonArray(value)) {
    return value.items.some((item) => hasNativeVisionInput(item));
  }
  return false;
}

function nativeInitiator(value: WireJson | undefined): "user" | "agent" {
  if (isWireJsonObject(value) && memberValues(value, "role")[0] === "assistant") {
    return "agent";
  }
  return "user";
}

function stringMember(object: WireJsonObject, key: string): string | undefined {
  const value = memberValues(object, key)[0];
  return typeof value === "string" ? value : undefined;
}

function integerMember(object: WireJsonObject, key: string): number | undefined {
  const value = memberValues(object, key)[0];
  if (!isWireJsonNumber(value)) {
    return undefined;
  }
  const parsed = Number(value.lexeme);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function objectMember(object: WireJsonObject, key: string): WireJsonObject | undefined {
  const value = memberValues(object, key)[0];
  return isWireJsonObject(value) ? value : undefined;
}

function replaceMember(object: WireJsonObject, key: string, value: WireJson): WireJsonObject {
  let replaced = false;
  const members = object.members.map((member) => {
    if (member.key !== key) {
      return member;
    }
    replaced = true;
    return { key, value };
  });
  if (!replaced) {
    members.push({ key, value });
  }
  return { kind: "object", members };
}

function replaceExistingStringMember(object: WireJsonObject, key: string, value: string): WireJsonObject {
  return {
    kind: "object",
    members: object.members.map((member) => member.key === key && typeof member.value === "string"
      ? { key, value }
      : member),
  };
}

function isEventStream(headers: Headers): boolean {
  return headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}
