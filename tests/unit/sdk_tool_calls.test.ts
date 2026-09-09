import { describe, expect, it } from "vitest";
import { sdkToolCalls as sessionCalls, type SdkProtocolResult as SessionResult } from "../sdk/client.js";

// Minimal SDK-parsed result shapes exercise extraction, not a second wire decoder.
function result(protocol: "chat" | "responses", argumentsJson: string): SessionResult {
  const response = protocol === "chat"
    ? { choices: [{ message: { tool_calls: [{ type: "function", id: "call_test", function: { name: "lookup", arguments: argumentsJson } }] } }] }
    : { output: [{ type: "function_call", call_id: "call_test", name: "lookup", arguments: argumentsJson }] };
  return { protocol, result: { response, text: "", terminal: "completed" } } as SessionResult;
}

describe("SDK tool argument extraction privacy", () => {
  it.each(["chat", "responses"] as const)("sanitizes malformed %s arguments without retaining a parser cause", (protocol) => {
    let error: unknown;
    try { sessionCalls(result(protocol, "synthetic-private-probe")); }
    catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Invalid SDK tool arguments");
    expect(error).not.toHaveProperty("cause");
  });

  it.each(["chat", "responses"] as const)("preserves parsed %s call identity and arguments", (protocol) => {
    expect(sessionCalls(result(protocol, "{\"q\":\"synthetic\"}"))).toEqual([
      { id: "call_test", name: "lookup", arguments: { q: "synthetic" } },
    ]);
  });
});
