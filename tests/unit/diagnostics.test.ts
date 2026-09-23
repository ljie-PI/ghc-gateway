import { describe, expect, it } from "vitest";
import { GatewayFailureError } from "../../src/gateway/failures.js";
import { ConversionContractError } from "../../src/protocols/conversion/types.js";
import { CONVERSION_DEGRADATION_RULES } from "../../src/protocols/conversion/degradations.js";
import { diagnosticResponsesReasoning, diagnosticShape } from "../../src/protocols/conversion/diagnostics.js";
import { isWireJsonObject, parseWireJson } from "../../src/serialization/wire_json.js";
import { DiagnosticRecorder, DIAGNOSTIC_LIMITS, type DiagnosticRecord } from "../../src/telemetry/diagnostics.js";

function recorder() {
  const records: DiagnosticRecord[] = [];
  const diagnostics = new DiagnosticRecorder({ write: (record) => records.push(record) }, {
    nowMs: () => 100, monotonicNowMs: () => 10,
  });
  return { diagnostics, records };
}

describe("content-free request diagnostics", () => {
  it("sanitizes every finite conversion degradation through the shared registry", async () => {
    const { diagnostics, records } = recorder();
    const trace = diagnostics.begin("req_degradations", "responses");
    trace.set({ degradations: CONVERSION_DEGRADATION_RULES });
    trace.finish();
    await diagnostics.close();
    expect(records.at(-1)?.degradations).toEqual(CONVERSION_DEGRADATION_RULES);
  });

  it("preserves rule IDs without exposing causes, bodies, or arbitrary keys", async () => {
    const { diagnostics, records } = recorder();
    const trace = diagnostics.begin("req_example", "messages");
    const input = parseWireJson(new TextEncoder().encode(JSON.stringify({
      model: "PRIVATE_MODEL", messages: [{ role: "user", content: "PRIVATE_PROMPT" }],
      tools: [{ name: "PRIVATE_TOOL", input_schema: { PRIVATE_PROPERTY: "PRIVATE_SCHEMA" } }],
      PRIVATE_KEY: "PRIVATE_VALUE", max_tokens: "PRIVATE_LIMIT",
    })), { maxBytes: 1024 * 1024, maxDepth: 64 });
    trace.stage("request_decoded", { shape: diagnosticShape(input) });
    trace.failure(new GatewayFailureError({
      kind: "invalid_request", source: "converter", phase: "convert",
      cause: new ConversionContractError("invalid_request", "REQ-M-LIMIT"),
    }));
    trace.set({ httpStatus: 400 });
    trace.finish();
    trace.finish();
    await diagnostics.close();
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
    expect(records.filter((record) => record.event === "request_finished")).toMatchObject([{
      requestId: "req_example", httpStatus: 400, outcome: "client_error",
      failure: { kind: "invalid_request", ruleId: "REQ-M-LIMIT" },
    }]);
    expect(records.find((record) => record.shape !== undefined)?.shape).toMatchObject({
      fields: { model: "string", max_tokens: "string" },
      counts: { messages: 1, tools: 1, unknownFields: 1 },
    });
  });

  it("does not serialize arbitrary exception messages or nested causes", async () => {
    const { diagnostics, records } = recorder();
    const trace = diagnostics.begin("req_error", "chat");
    trace.failure(new Error("PRIVATE_ERROR", { cause: { ruleId: "REQ-PRIVATE-CAUSE", secret: "PRIVATE_TOKEN" } }));
    trace.finish();
    await diagnostics.close();
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
    expect(records.at(-1)?.failure).toEqual({ kind: "internal", source: "gateway", phase: "internal" });
  });

  it("reserves request record slots for failure and finalization", async () => {
    const { diagnostics, records } = recorder();
    const trace = diagnostics.begin("req_limited", "responses");
    for (let index = 0; index < 100; index++) trace.stage("planning");
    trace.failure(new GatewayFailureError({ kind: "upstream_http", status: 400 }));
    trace.finish();
    await diagnostics.close();
    const request = records.filter((record) => record.requestId !== undefined);
    expect(request).toHaveLength(DIAGNOSTIC_LIMITS.requestRecords);
    expect(request.slice(-2).map((record) => record.event)).toEqual(["request_failed", "request_finished"]);
    expect(request.at(-1)?.omittedRecords).toBeGreaterThan(0);
    expect(diagnostics.snapshot()).toMatchObject({ state: "degraded", reason: "record_limit" });
  });

  it("bounds the queue and reports drops while prioritizing final results", async () => {
    const { diagnostics, records } = recorder();
    const traces = Array.from({ length: 400 }, (_, index) => diagnostics.begin(`req_${index}`, "chat"));
    expect(diagnostics.snapshot().pendingRecords).toBe(DIAGNOSTIC_LIMITS.queueRecords);
    traces[0]!.finish();
    await diagnostics.close();
    expect(diagnostics.snapshot()).toMatchObject({ state: "degraded", pendingRecords: 0, reason: "queue_full" });
    expect(diagnostics.snapshot().droppedRecords).toBeGreaterThan(0);
    expect(records.some((record) => record.event === "request_finished")).toBe(true);
  });

  it("aggregates a long stream using a finite event vocabulary", async () => {
    const { diagnostics, records } = recorder();
    const trace = diagnostics.begin("req_stream", "responses");
    trace.set({ reasoningEffort: "high", reasoningSummary: "detailed", reasoningTokens: 13 });
    for (let index = 0; index < 10_000; index++) {
      trace.event("response.output_text.delta");
      trace.event(`PRIVATE_EVENT_${index}`);
      trace.bytes("upstream", 20);
    }
    trace.event("response.reasoning_summary_part.added");
    trace.event("response.reasoning_summary_text.delta");
    trace.event("response.reasoning_summary_text.done");
    trace.event("response.reasoning_summary_part.done");
    trace.event("response.reasoning_text.delta");
    trace.event("response.reasoning_text.done");
    trace.terminal("semantic_success");
    trace.finish();
    await diagnostics.close();
    expect(records).toHaveLength(3);
    expect(records.at(-1)).toMatchObject({
      upstreamBytes: 200_000, terminalCause: "semantic_success",
      reasoningEffort: "high", reasoningSummary: "detailed", reasoningTokens: 13,
      sse: {
        "response.output_text.delta": 10_000,
        "response.reasoning_summary_part.added": 1,
        "response.reasoning_summary_text.delta": 1,
        "response.reasoning_summary_text.done": 1,
        "response.reasoning_summary_part.done": 1,
        "response.reasoning_text.delta": 1,
        "response.reasoning_text.done": 1,
        unknown: 10_000,
      },
    });
    expect(JSON.stringify(records)).not.toContain("PRIVATE");
  });

  it("records only allowlisted Responses reasoning modes", () => {
    const recognized = parseWireJson(new TextEncoder().encode(JSON.stringify({
      reasoning: { effort: "xhigh", summary: "concise" },
    })), { maxBytes: 1024, maxDepth: 8 });
    const unknown = parseWireJson(new TextEncoder().encode(JSON.stringify({
      reasoning: { effort: "PRIVATE_EFFORT", summary: "PRIVATE_SUMMARY" },
    })), { maxBytes: 1024, maxDepth: 8 });
    if (!isWireJsonObject(recognized) || !isWireJsonObject(unknown)) throw new Error("expected object");

    expect(diagnosticResponsesReasoning(recognized)).toEqual({
      reasoningEffort: "xhigh",
      reasoningSummary: "concise",
    });
    const sanitized = diagnosticResponsesReasoning(unknown);
    expect(sanitized).toEqual({ reasoningEffort: "unknown", reasoningSummary: "unknown" });
    expect(JSON.stringify(sanitized)).not.toContain("PRIVATE");
  });

  it("fails initial writes, but isolates later sink and observer failures with visible status", async () => {
    expect(() => new DiagnosticRecorder({ write: () => { throw new Error("private path"); } })).toThrow();
    let writes = 0;
    let warnings = 0;
    const diagnostics = new DiagnosticRecorder({
      write: () => { if (++writes > 1) throw new Error("PRIVATE_IO_ERROR"); },
    }, { onFailure: () => { warnings++; throw new Error("PRIVATE_WARNING_FAILURE"); } });
    diagnostics.begin("req_io", "messages").finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(diagnostics.snapshot()).toMatchObject({ state: "failed", reason: "io_error", pendingRecords: 0 });
    expect(diagnostics.snapshot().droppedRecords).toBe(2);
    expect(warnings).toBe(1);
    let shapes = 0;
    const later = diagnostics.begin("req_after_failure", "messages");
    later.stage("planning");
    later.shape("upstream_output", () => { shapes++; throw new Error("must not inspect"); });
    later.shape("upstream_output", () => { shapes++; throw new Error("must not inspect"); });
    later.failure(new Error("PRIVATE_LATE"));
    later.failure(new Error("PRIVATE_DUPLICATE"));
    later.finish();
    later.finish();
    expect(diagnostics.snapshot().droppedRecords).toBe(7);
    expect(shapes).toBe(0);
    expect(writes).toBe(2);
    await diagnostics.close();

    const { diagnostics: broken } = recorder();
    broken.begin("req_observer", "chat").observe(() => { throw new Error("PRIVATE_SHAPE_ERROR"); });
    expect(broken.snapshot()).toMatchObject({ state: "failed", reason: "observer_error" });
    await broken.close();
  });

  it("isolates a failed diagnostic clock and coalesces concurrent close calls", async () => {
    const failed = new DiagnosticRecorder({ write() {} }, {
      monotonicNowMs: () => { throw new Error("PRIVATE_CLOCK"); },
    });
    expect(() => failed.begin("req_clock", "chat").finish()).not.toThrow();
    expect(failed.snapshot()).toMatchObject({ state: "failed", reason: "observer_error" });
    await failed.close();

    const { diagnostics, records } = recorder();
    diagnostics.begin("req_close", "chat").finish();
    await Promise.all(Array.from({ length: 100 }, () => diagnostics.close()));
    expect(records.filter((record) => record.event === "request_finished")).toHaveLength(1);
  });

  it("bounds shape traversal and omits arbitrary schema and content keys", () => {
    const input = parseWireJson(new TextEncoder().encode(JSON.stringify({
      messages: Array.from({ length: 1000 }, () => ({
        role: "user", content: [{ type: "text", text: "PRIVATE_TEXT" }],
      })),
      PRIVATE_KEY: "PRIVATE_VALUE",
    })), { maxBytes: 1024 * 1024, maxDepth: 64 });
    const shape = diagnosticShape(input);
    expect(shape.truncated).toBe(true);
    expect(shape.counts.messages).toBe(1000);
    expect(shape.blocks.text).toBeLessThan(DIAGNOSTIC_LIMITS.shapeNodes);
    expect(JSON.stringify(shape)).not.toContain("PRIVATE");
  });
});
