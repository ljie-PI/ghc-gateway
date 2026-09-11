import { describe, expect, it } from "vitest";
import { GatewayFailureError } from "../../src/gateway/failures.js";
import { createRequestAttempt } from "../../src/gateway/request_attempt.js";
import type { UsageUpdate } from "../../src/telemetry/recorder.js";

describe("RequestAttempt", () => {
  it("retains attribution monotonically and claims finalization exactly once", () => {
    const updates: UsageUpdate[] = [];
    let now = 100;
    const attempt = createRequestAttempt({
      requestId: "req_attempt",
      protocol: "openai_responses_unknown",
      recorder: { recordUsage: (update) => updates.push(update) },
      nowMs: () => {
        now += 5;
        return now;
      },
      abortedErrorCount: 1,
    });

    attempt.setRequestedModel("requested");
    attempt.setRequestedModel("ignored");
    attempt.setAccount("github.com/1");
    attempt.setAccount("github.com/2");
    attempt.setResolvedModel("resolved");
    attempt.setResolvedModel("ignored");
    attempt.setProtocol("openai_responses_native");
    attempt.setProtocol("openai_responses_bridge");
    attempt.observeUsage({ inputTokens: 9, outputTokens: 4, cacheTokens: 2 });
    attempt.success();
    attempt.failure(new GatewayFailureError({ kind: "upstream_timeout" }));

    expect(attempt.finalized).toBe(true);
    expect(updates).toEqual([{
      occurredAtMs: 110,
      accountId: "github.com/1",
      protocol: "openai_responses_native",
      resolvedModel: "resolved",
      outcome: "success",
      requestCount: 1,
      errorCount: 0,
      inputTokens: 9,
      outputTokens: 4,
      cacheTokens: 2,
      latencyMs: 5,
    }]);
  });

  it("tracks preparation, handoff, and first-byte commitment separately", () => {
    const attempt = createRequestAttempt({
      requestId: "req_phases",
      protocol: "openai_chat",
      abortedErrorCount: 0,
    });
    expect(attempt).toMatchObject({
      prepared: false,
      handedOff: false,
      committed: false,
    });
    attempt.markCommitted();
    expect(attempt.committed).toBe(false);
    attempt.markPrepared();
    attempt.markHandedOff();
    expect(attempt).toMatchObject({
      prepared: true,
      handedOff: true,
      committed: false,
    });
    attempt.markCommitted();
    expect(attempt.committed).toBe(true);
  });

  it("preserves failure token and route-specific aborted error-count policies", () => {
    const responses: UsageUpdate[] = [];
    const messages: UsageUpdate[] = [];
    const timeout = createRequestAttempt({
      requestId: "req_timeout",
      protocol: "openai_responses_unknown",
      recorder: { recordUsage: (update) => responses.push(update) },
      abortedErrorCount: 1,
    });
    timeout.observeUsage({ inputTokens: 9, outputTokens: 4, cacheTokens: 2 });
    timeout.failure(new GatewayFailureError({ kind: "upstream_timeout" }));

    const aborted = createRequestAttempt({
      requestId: "req_aborted",
      protocol: "openai_chat",
      recorder: { recordUsage: (update) => messages.push(update) },
      abortedErrorCount: 0,
    });
    aborted.failure(new GatewayFailureError({ kind: "aborted" }));

    expect(responses).toMatchObject([{
      outcome: "timeout",
      errorCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
    }]);
    expect(messages).toMatchObject([{ outcome: "aborted", errorCount: 0 }]);
  });

  it.each([
    {
      first: new GatewayFailureError({ kind: "upstream_timeout" }),
      second: new GatewayFailureError({ kind: "aborted" }),
      outcome: "timeout",
    },
    {
      first: new GatewayFailureError({ kind: "aborted" }),
      second: new GatewayFailureError({ kind: "upstream_timeout" }),
      outcome: "aborted",
    },
  ] as const)("linearizes timeout and client-cancel races at the first claim", ({ first, second, outcome }) => {
    const updates: UsageUpdate[] = [];
    const attempt = createRequestAttempt({
      requestId: "req_race",
      protocol: "openai_responses_native",
      recorder: { recordUsage: (update) => updates.push(update) },
      abortedErrorCount: 1,
    });
    attempt.failure(first);
    attempt.failure(second);
    expect(updates).toHaveLength(1);
    expect(updates).toMatchObject([{ outcome }]);
  });
});
