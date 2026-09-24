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
});
