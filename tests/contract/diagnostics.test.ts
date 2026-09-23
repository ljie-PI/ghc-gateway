import { describe, expect, it } from "vitest";
import { DiagnosticRecorder, type DiagnosticRecord } from "../../src/telemetry/diagnostics.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { anthropicGateway, anthropicRequest } from "./anthropic_harness.js";
import { jsonStream } from "../../scripts/tooling/test_support/http_copilot.js";

const body = { model: "gpt", max_tokens: 16, messages: [{ role: "user", content: "PRIVATE_PROMPT" }] };
const firstChunk = "data: {\"choices\":[{\"delta\":{\"content\":\"PRIVATE_REPLY\"},\"finish_reason\":null}]}\n\n";

function collector() {
  const records: DiagnosticRecord[] = [];
  const diagnostics = new DiagnosticRecorder({ write: (record) => records.push(record) }, {
    nowMs: () => 100, monotonicNowMs: () => 10,
  });
  return { records, diagnostics };
}

describe("diagnostic failure contracts", () => {
  it.each([
    { headers: { "anthropic-version": "PRIVATE_VERSION" }, input: body, code: "anthropic_version_unsupported", rule: undefined },
    { headers: { "anthropic-beta": "PRIVATE_BETA," }, input: body, code: "anthropic_beta_unsupported", rule: undefined },
    { headers: {}, input: { ...body, messages: "PRIVATE_MESSAGES" }, code: undefined, rule: "REQ-M-MESSAGES" },
  ])("identifies local rejection without exposing input: $code $rule", async ({ headers, input, code, rule }) => {
    const { diagnostics, records } = collector();
    const harness = await anthropicGateway({ gatewayDependencies: { diagnostics }, expectations: [] });
    try {
      const response = await harness.gw.fetch(anthropicRequest(input, headers));
      expect(response.status).toBe(400);
      await response.text();
      await diagnostics.close();
      expect(harness.upstream.requests).toHaveLength(0);
      expect(records.filter((record) => record.event === "request_finished")).toMatchObject([{
        httpStatus: 400, outcome: "client_error",
      }]);
      if (code !== undefined) expect(records.some((record) => record.code === code)).toBe(true);
      if (rule !== undefined) expect(records.at(-1)?.failure?.ruleId).toBe(rule);
      expect(JSON.stringify(records)).not.toContain("PRIVATE");
    } finally {
      await harness.close();
      await diagnostics.close();
    }
  });

  it("identifies malformed JSON as request decoding rather than admission", async () => {
    const { diagnostics, records } = collector();
    const harness = await anthropicGateway({ gatewayDependencies: { diagnostics }, expectations: [] });
    try {
      const response = await harness.gw.fetch(new Request("http://127.0.0.1:31400/v1/messages", {
        method: "POST", headers: { "content-type": "application/json" },
        body: "{\"PRIVATE_JSON\":",
      }));
      expect(response.status).toBe(400);
      await response.text();
      await diagnostics.close();
      expect(records.find((record) => record.event === "request_failed")).toMatchObject({
        stage: "request_decode", failure: { kind: "invalid_request", source: "request", phase: "decode" },
      });
      expect(JSON.stringify(records)).not.toContain("PRIVATE");
    } finally {
      await harness.close();
      await diagnostics.close();
    }
  });

  it("records allowlisted beta hints and their conversion degradation", async () => {
    const { diagnostics, records } = collector();
    const harness = await anthropicGateway({ gatewayDependencies: { diagnostics } });
    try {
      const response = await harness.gw.fetch(anthropicRequest(body, { "anthropic-beta": "prompt-caching-2024-07-31" }));
      expect(response.status).toBe(200);
      await response.text();
      await diagnostics.close();
      expect(records.at(-1)?.messagesBetas).toEqual(["prompt-caching-2024-07-31"]);
      expect(records.some((record) => record.degradations?.includes("cache.control_omitted"))).toBe(true);
    } finally {
      await harness.close();
      await diagnostics.close();
    }
  });

  it("records only allowlisted beta values and a finite unknown count", async () => {
    const { diagnostics, records } = collector();
    const harness = await anthropicGateway({ gatewayDependencies: { diagnostics } });
    try {
      const response = await harness.gw.fetch(anthropicRequest({
        ...body,
        context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
        PRIVATE_EXTENSION: "PRIVATE_DATA",
      }, {
        "anthropic-beta": "claude-code-20250219,PRIVATE_BETA,interleaved-thinking-2025-05-14,PRIVATE_OTHER",
      }));
      expect(response.status).toBe(200);
      await response.text();
      await diagnostics.close();
      expect(records.at(-1)).toMatchObject({
        messagesBetas: ["claude-code-20250219", "interleaved-thinking-2025-05-14"],
        unknownBetaCount: 2,
      });
      expect(records.some((record) => record.degradations?.includes("messages.extensions_omitted"))).toBe(true);
      expect(JSON.stringify(records)).not.toContain("PRIVATE");
    } finally {
      await harness.close();
      await diagnostics.close();
    }
  });

  it("records an upstream HTTP rejection without reading its error body", async () => {
    const { diagnostics, records } = collector();
    const harness = await anthropicGateway({
      gatewayDependencies: { diagnostics },
      expectations: [{
        method: "POST", path: "/chat/completions", body: jsonStream(true),
        reply: { status: 400, body: Buffer.from("{\"error\":\"PRIVATE_UPSTREAM_ERROR\"}") },
      }],
    });
    try {
      const response = await harness.gw.fetch(anthropicRequest({ ...body, stream: true }));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("upstream request failed");
      await diagnostics.close();
      expect(records.at(-1)).toMatchObject({
        httpStatus: 400, upstreamStatus: 400, upstreamProtocol: "chat",
        failure: { kind: "upstream_http" }, outcome: "upstream_error",
      });
      expect(records.some((record) => record.code === "status_only")).toBe(true);
      expect(JSON.stringify(records)).not.toContain("PRIVATE");
    } finally {
      await harness.close();
      await diagnostics.close();
    }
  });

  it("distinguishes postcommit failure from the HTTP 200 already delivered", async () => {
    const { diagnostics, records } = collector();
    const harness = await anthropicGateway({
      gatewayDependencies: { diagnostics },
      expectations: [{
        method: "POST", path: "/chat/completions", body: jsonStream(true),
        reply: {
          headers: { "content-type": "text/event-stream" },
          body: Buffer.from(`${firstChunk}data: {"error":{"message":"PRIVATE_UPSTREAM_ERROR"}}\n\n`),
        },
      }],
    });
    try {
      const response = await harness.gw.fetch(anthropicRequest({ ...body, stream: true }));
      expect(response.status).toBe(200);
      await expect(response.text()).rejects.toThrow();
      await diagnostics.close();
      expect(records.filter((record) => record.event === "request_finished")).toMatchObject([{
        httpStatus: 200, upstreamStatus: 200, terminalCause: "postcommit_failure", outcome: "upstream_error",
      }]);
      expect(JSON.stringify(records)).not.toContain("PRIVATE");
    } finally {
      await harness.close();
      await diagnostics.close();
    }
  });

  it("records client cancellation once and releases the live upstream", async () => {
    const { diagnostics, records } = collector();
    const harness = await anthropicGateway({
      gatewayDependencies: { diagnostics },
      expectations: [{
        method: "POST", path: "/chat/completions", body: jsonStream(true),
        reply: {
          headers: { "content-type": "text/event-stream" },
          stream: async (exchange) => { await exchange.write(Buffer.from(firstChunk)); await exchange.waitForClose(); },
        },
      }],
    });
    try {
      const response = await harness.gw.fetch(anthropicRequest({ ...body, stream: true }));
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      await diagnostics.close();
      expect(records.filter((record) => record.event === "request_finished")).toMatchObject([{
        httpStatus: 200, outcome: "aborted", terminalCause: "client_cancel",
      }]);
      expect(harness.backend.inspect().responseLeases).toBe(0);
    } finally {
      await harness.close();
      await diagnostics.close();
    }
  });

  it("records a deadline without creating a successful trace", async () => {
    const { diagnostics, records } = collector();
    const runtime = defaultRuntimeConfigSnapshot();
    runtime.timeouts.totalMs = 100;
    const harness = await anthropicGateway({
      runtime, gatewayDependencies: { diagnostics },
      expectations: [{
        method: "POST", path: "/chat/completions", body: jsonStream(true),
        reply: { stream: async (exchange) => { await exchange.waitForClose(); } },
      }],
    });
    try {
      const response = await harness.gw.fetch(anthropicRequest({ ...body, stream: true }));
      expect(response.status).toBe(504);
      await response.text();
      await diagnostics.close();
      expect(records.at(-1)).toMatchObject({ httpStatus: 504, outcome: "timeout", failure: { kind: "upstream_timeout" } });
    } finally {
      await harness.close();
      await diagnostics.close();
    }
  });

  it("keeps inference successful when the diagnostic sink fails", async () => {
    let writes = 0;
    const diagnostics = new DiagnosticRecorder({
      write: () => { if (++writes > 1) throw new Error("PRIVATE_DISK_FAILURE"); },
    });
    const harness = await anthropicGateway({ gatewayDependencies: { diagnostics } });
    try {
      const response = await harness.gw.fetch(anthropicRequest(body));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("ok");
      await diagnostics.close();
      expect(diagnostics.snapshot()).toMatchObject({ enabled: true, state: "failed", reason: "io_error" });
    } finally {
      await harness.close();
      await diagnostics.close();
    }
  });
});
