import {
  isWireJsonArray,
  isWireJsonObject,
  memberValues,
  type WireJson,
  type WireJsonArray,
  type WireJsonObject,
} from "../../serialization/wire_json.js";
import { wireArray, wireObject } from "./wire.js";

/** Anthropic accepts at most four cache breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;
const EPHEMERAL = wireObject([["type", "ephemeral"]]);

/**
 * Port of cc-switch's `cache_injector::inject` for converted Messages requests. Chat and Responses
 * clients cannot express Anthropic prompt caching, which is opt-in, so stable prefixes are marked
 * here: the last tool, the end of `system`, the newest cacheable message block and, for longer
 * histories, the second-newest user message. Converted bodies currently carry no markers and an
 * array `system`; the existing-marker budget and string `system` handling keep cc-switch's
 * semantics for any caller that does.
 */
export function withMessagesCacheBreakpoints(body: WireJsonObject): WireJsonObject {
  let budget = MAX_CACHE_BREAKPOINTS - countBreakpoints(body);
  if (budget <= 0) return body;
  let result = body;

  const tools = memberValue(result, "tools");
  if (isWireJsonArray(tools)) {
    const last = tools.items.length - 1;
    const tool = tools.items[last];
    if (isWireJsonObject(tool) && !hasCacheControl(tool)) {
      result = withMember(result, "tools", withItem(tools, last, withCacheControl(tool)));
      budget -= 1;
    }
  }

  if (budget > 0) {
    let system = memberValue(result, "system");
    if (typeof system === "string") {
      system = wireArray([wireObject([["type", "text"], ["text", system]])]);
    }
    if (isWireJsonArray(system)) {
      const last = system.items.length - 1;
      const block = system.items[last];
      if (isWireJsonObject(block) && !hasCacheControl(block)) {
        result = withMember(result, "system", withItem(system, last, withCacheControl(block)));
        budget -= 1;
      }
    }
  }

  const messages = memberValue(result, "messages");
  if (budget <= 0 || !isWireJsonArray(messages)) return result;
  let items = messages.items;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const marked = withMessageBreakpoint(items[index]);
    if (marked !== undefined) {
      items = replaced(items, index, marked);
      budget -= 1;
      break;
    }
  }
  // A second, older user anchor helps long tool loops whose stable prefix falls outside Anthropic's
  // 20-block lookback from the newest breakpoint.
  if (budget > 0 && items.length >= 4) {
    let users = 0;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const message = items[index];
      if (!isWireJsonObject(message) || memberValue(message, "role") !== "user") continue;
      users += 1;
      if (users === 2) {
        const marked = withMessageBreakpoint(message);
        if (marked !== undefined) items = replaced(items, index, marked);
        break;
      }
    }
  }
  return items === messages.items ? result : withMember(result, "messages", wireArray(items));
}

function withMessageBreakpoint(message: WireJson | undefined): WireJsonObject | undefined {
  if (!isWireJsonObject(message)) return undefined;
  const content = memberValue(message, "content");
  if (!isWireJsonArray(content)) return undefined;
  for (let index = content.items.length - 1; index >= 0; index -= 1) {
    const block = content.items[index];
    if (!isWireJsonObject(block)) return undefined;
    const type = memberValue(block, "type");
    // Thinking blocks cannot carry cache_control.
    if (type === "thinking" || type === "redacted_thinking") continue;
    if (hasCacheControl(block)) return undefined;
    return withMember(message, "content", withItem(content, index, withCacheControl(block)));
  }
  return undefined;
}

function countBreakpoints(body: WireJsonObject): number {
  let count = 0;
  const countIn = (value: WireJson | undefined): void => {
    if (!isWireJsonArray(value)) return;
    for (const item of value.items) if (isWireJsonObject(item) && hasCacheControl(item)) count += 1;
  };
  countIn(memberValue(body, "tools"));
  countIn(memberValue(body, "system"));
  const messages = memberValue(body, "messages");
  if (isWireJsonArray(messages)) {
    for (const message of messages.items) if (isWireJsonObject(message)) countIn(memberValue(message, "content"));
  }
  return count;
}

function hasCacheControl(object: WireJsonObject): boolean {
  return memberValues(object, "cache_control").length > 0;
}

function withCacheControl(object: WireJsonObject): WireJsonObject {
  return { kind: "object", members: [...object.members, { key: "cache_control", value: EPHEMERAL }] };
}

function memberValue(object: WireJsonObject, key: string): WireJson | undefined {
  return memberValues(object, key)[0];
}

function withMember(object: WireJsonObject, key: string, value: WireJson): WireJsonObject {
  return { kind: "object", members: object.members.map((member) => member.key === key ? { key, value } : member) };
}

function withItem(array: WireJsonArray, index: number, value: WireJson): WireJsonArray {
  return wireArray(replaced(array.items, index, value));
}

function replaced(items: readonly WireJson[], index: number, value: WireJson): readonly WireJson[] {
  return items.map((item, position) => position === index ? value : item);
}
