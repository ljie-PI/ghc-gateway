import { describe, expect, it } from "vitest";
import { withMessagesCacheBreakpoints } from "../../src/protocols/conversion/messages_cache_breakpoints.js";
import { isWireJsonObject, parseWireJson, serializeWireJson, type WireJsonObject } from "../../src/serialization/wire_json.js";

// Cases ported from cc-switch `src-tauri/src/proxy/cache_injector.rs` tests.
const EPHEMERAL = { type: "ephemeral" };

function wire(value: unknown): WireJsonObject {
  const parsed = parseWireJson(new TextEncoder().encode(JSON.stringify(value)), { maxBytes: 1 << 20, maxDepth: 64 });
  if (!isWireJsonObject(parsed)) throw new Error("expected object");
  return parsed;
}

function inject(value: unknown): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(serializeWireJson(withMessagesCacheBreakpoints(wire(value))))) as Record<string, unknown>;
}

function count(value: unknown): number {
  return (JSON.stringify(value).match(/"cache_control"/gu) ?? []).length;
}

describe("converted Messages cache breakpoints", () => {
  it("marks the only user message of a minimal body", () => {
    expect(inject({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })).toEqual({
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: EPHEMERAL }] }],
    });
  });

  it("marks the last tool, the end of system and the newest message", () => {
    const result = inject({
      model: "m",
      system: [{ type: "text", text: "sys prompt" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ],
      tools: [{ name: "tool1", input_schema: {} }, { name: "tool2", input_schema: {} }],
    });
    expect(result).toEqual({
      model: "m",
      system: [{ type: "text", text: "sys prompt", cache_control: EPHEMERAL }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello", cache_control: EPHEMERAL }] },
      ],
      tools: [{ name: "tool1", input_schema: {} }, { name: "tool2", input_schema: {}, cache_control: EPHEMERAL }],
    });
  });

  it("adds a prior user anchor as the fourth breakpoint for longer histories", () => {
    const result = inject({
      model: "m",
      system: [{ type: "text", text: "sys" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "assistant", content: [{ type: "text", text: "answer" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "result" }] }] },
        { role: "assistant", content: [{ type: "text", text: "latest" }] },
      ],
      tools: [{ name: "tool1", input_schema: {} }],
    });
    expect(count(result)).toBe(4);
    const messages = result.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0]?.content[0]?.cache_control).toEqual(EPHEMERAL);
    expect(messages[2]?.content[0]?.cache_control).toBeUndefined();
    expect(messages[3]?.content[0]?.cache_control).toEqual(EPHEMERAL);
  });

  it("keeps client markers and their ttl unchanged when they use the whole budget", () => {
    const body = {
      model: "m",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: [{ role: "assistant", content: [{ type: "text", text: "ok", cache_control: { type: "ephemeral", ttl: "1h" } }] }],
      tools: [
        { name: "t1", cache_control: { type: "ephemeral", ttl: "1h" } },
        { name: "t2", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
    };
    expect(inject(body)).toEqual(body);
  });

  it("spends only the remaining budget next to existing markers", () => {
    const result = inject({
      model: "m",
      system: [{ type: "text", text: "sys" }],
      messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
      tools: [{ name: "t1", cache_control: EPHEMERAL }, { name: "t2", cache_control: EPHEMERAL }],
    });
    expect(count(result)).toBe(4);
    expect((result.system as Array<Record<string, unknown>>)[0]?.cache_control).toEqual(EPHEMERAL);
    expect((result.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]?.content[0]?.cache_control).toEqual(EPHEMERAL);
  });

  it("leaves more than four existing markers unchanged", () => {
    const body = {
      model: "m",
      system: [{ type: "text", text: "s1", cache_control: EPHEMERAL }, { type: "text", text: "s2", cache_control: EPHEMERAL }],
      messages: [{ role: "user", content: [{ type: "text", text: "m1", cache_control: EPHEMERAL }, { type: "text", text: "m2" }] }],
      tools: [{ name: "t1", cache_control: EPHEMERAL }, { name: "t2", cache_control: EPHEMERAL }],
    };
    expect(inject(body)).toEqual(body);
  });

  it("converts a string system prompt into a marked text block", () => {
    expect(inject({
      model: "m",
      system: "You are a helpful assistant",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }).system).toEqual([{ type: "text", text: "You are a helpful assistant", cache_control: EPHEMERAL }]);
  });

  it("skips thinking blocks when marking an assistant message", () => {
    const result = inject({
      model: "m",
      messages: [{ role: "assistant", content: [
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "text", text: "result" },
        { type: "redacted_thinking", data: "xxx" },
      ] }],
    });
    expect((result.messages as Array<{ content: unknown[] }>)[0]?.content).toEqual([
      { type: "thinking", thinking: "hmm", signature: "sig" },
      { type: "text", text: "result", cache_control: EPHEMERAL },
      { type: "redacted_thinking", data: "xxx" },
    ]);
  });

  it("marks the newest tool result instead of the older assistant tool use", () => {
    const result = inject({
      model: "m",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "done" }] }] },
      ],
    });
    const messages = result.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0]?.content[0]?.cache_control).toBeUndefined();
    expect(messages[1]?.content[0]?.cache_control).toEqual(EPHEMERAL);
  });

  it("falls back to an older message when the newest has no cacheable block", () => {
    const result = inject({
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "question" }] },
        { role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }] },
      ],
    });
    const messages = result.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0]?.content[0]?.cache_control).toEqual(EPHEMERAL);
    expect(messages[1]?.content[0]?.cache_control).toBeUndefined();
  });
});
