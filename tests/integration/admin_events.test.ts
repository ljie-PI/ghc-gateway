import { describe, expect, it } from "vitest";
import { createAdminModule } from "../../src/admin/routes.js";
import { ADMIN_EVENT_SUBSCRIBER_CAP } from "../../src/admin/events.js";
import type { AdminModule } from "../../src/gateway/create_gateway.js";
import { createGateway, type Gateway } from "../../src/gateway/create_gateway.js";
import { defaultRuntimeConfigSnapshot } from "../../src/config/schema.js";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { adminDependencies, operationalEvent, type TestAdminDependencies } from "../contract/admin_test_harness.js";

const ORIGIN = "http://127.0.0.1:31400";

describe("Admin event stream", () => {
  it("emits exact replay, performance, operational, and reset frames", async () => {
    const harness = await createHarness();
    try {
      const replay = await open(harness.gateway, "1");
      const reader = replay.body!.getReader();
      expect(decode((await reader.read()).value)).toBe(
        `id: 2\nevent: operational\ndata: ${JSON.stringify({ kind: "operational", event: operationalEvent("2") })}\n\n`,
      );
      expect(decode((await reader.read()).value)).toContain("event: performance\ndata: {\"kind\":\"performance\",\"status\":");
      harness.dependencies.emitted.publish({ kind: "operational", event: operationalEvent("3") });
      expect(decode((await reader.read()).value)).toBe(
        `id: 3\nevent: operational\ndata: ${JSON.stringify({ kind: "operational", event: operationalEvent("3") })}\n\n`,
      );
      await reader.cancel();

      const reset = await open(harness.gateway, "99");
      const resetReader = reset.body!.getReader();
      expect(decode((await resetReader.read()).value)).toBe(
        "event: reset\ndata: {\"kind\":\"reset\",\"reason\":\"history_unavailable\",\"latestEventId\":\"2\"}\n\n",
      );
      await resetReader.cancel();
    } finally {
      await harness.close();
    }
  });

  it("rejects malformed Last-Event-ID, caps subscribers, and closes streams on Gateway close", async () => {
    const harness = await createHarness();
    try {
      expect((await open(harness.gateway, "01")).status).toBe(400);
      const responses: Response[] = [];
      for (let index = 0; index < ADMIN_EVENT_SUBSCRIBER_CAP; index += 1) {
        responses.push(await open(harness.gateway));
      }
      expect((await open(harness.gateway)).status).toBe(503);
      await harness.gateway.close();
      for (const response of responses) {
        const reader = response.body!.getReader();
        await reader.read();
        expect((await reader.read()).done).toBe(true);
      }
    } finally {
      await harness.close();
    }
  });

  it("emits a 15-second heartbeat only when no event is queued", async () => {
    let heartbeat: (() => void) | undefined;
    const base = adminDependencies();
    const dependencies: TestAdminDependencies = { ...base,
      setInterval: ((handler: TimerHandler) => {
        heartbeat = handler as () => void;
        return 1 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setInterval,
      clearInterval: (() => undefined) as typeof clearInterval,
    };
    const harness = await createHarness(dependencies);
    try {
      const response = await open(harness.gateway);
      const reader = response.body!.getReader();
      await reader.read();
      heartbeat?.();
      expect(decode((await reader.read()).value)).toBe(": keep-alive\n\n");
      await reader.cancel();
    } finally {
      await harness.close();
    }
  });

  it("loads retained replay lazily in bounded batches beyond the live queue cap", async () => {
    const dependencies = adminDependencies();
    const calls: string[] = [];
    dependencies.telemetry.replayEvents = async (after, signal) => {
      signal.throwIfAborted();
      calls.push(after);
      const start = Number(after) + 1;
      const items = Array.from(
        { length: Math.min(128, Math.max(0, 513 - start + 1)) },
        (_, index) => operationalEvent(String(start + index)),
      );
      return {
        found: true,
        latestEventId: "513",
        items,
      };
    };
    const harness = await createHarness(dependencies);
    try {
      const response = await open(harness.gateway, "1");
      expect(response.status).toBe(200);
      expect(calls).toEqual(["1"]);
      const reader = response.body!.getReader();
      let text = "";
      text += decode((await reader.read()).value);
      harness.dependencies.emitted.publish({ kind: "operational", event: operationalEvent("129") });
      harness.dependencies.emitted.publish({ kind: "operational", event: operationalEvent("514") });
      for (let index = 1; index < 514; index += 1) {
        text += decode((await reader.read()).value);
      }
      expect(calls).toEqual(["1", "33", "65", "97", "129", "161", "193", "225", "257", "289", "321", "353", "385", "417", "449", "481"]);
      expect(text).toContain("id: 2\n");
      expect(text).toContain("id: 513\n");
      expect(text).toContain("event: performance\n");
      expect(text.match(/id: 129\n/gu)).toHaveLength(1);
      expect(text.indexOf("id: 513\n")).toBeLessThan(text.indexOf("event: performance\n"));
      expect(text.indexOf("event: performance\n")).toBeLessThan(text.indexOf("id: 514\n"));
      await reader.cancel();
    } finally {
      await harness.close();
    }
  });

  it("closes a stream on caller abort", async () => {
    const harness = await createHarness();
    try {
      const caller = new AbortController();
      const abortedStream = await open(harness.gateway, undefined, caller.signal);
      const abortedReader = abortedStream.body!.getReader();
      await abortedReader.read();
      caller.abort();
      expect((await abortedReader.read()).done).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("disconnects a subscriber whose live queue reaches 128 events", async () => {
    const harness = await createHarness();
    try {
      const response = await open(harness.gateway);
      const reader = response.body!.getReader();
      await reader.read();
      for (let eventId = 1; eventId <= 129; eventId += 1) {
        harness.dependencies.emitted.publish({ kind: "operational", event: operationalEvent(String(eventId)) });
      }
      expect((await reader.read()).done).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("disconnects a subscriber whose live queue exceeds 1 MiB before 128 events", async () => {
    const harness = await createHarness();
    try {
      const response = await open(harness.gateway);
      const reader = response.body!.getReader();
      await reader.read();
      for (let eventId = 1; eventId <= 70; eventId += 1) {
        harness.dependencies.emitted.publish({
          kind: "operational",
          event: { ...operationalEvent(String(eventId)), metadata: { status: "x".repeat(16_000) } },
        });
      }
      expect((await reader.read()).done).toBe(true);
    } finally {
      await harness.close();
    }
  });
});

async function createHarness(dependencies = adminDependencies()): Promise<{
  readonly gateway: Gateway;
  readonly admin: AdminModule;
  readonly dependencies: TestAdminDependencies;
  readonly close: () => Promise<void>;
}> {
  const admin = createAdminModule(dependencies);
  const gateway = await createGateway({
    startup: parseStartupConfig([], {}, { homedir: "Q:/tmp/admin-events" }), runtime: defaultRuntimeConfigSnapshot(),
  }, [], { admin, createRequestId: () => "req_admin_events" });
  return { gateway, admin, dependencies, close: async () => gateway.close() };
}

async function open(
  gateway: Gateway,
  lastEventId?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const headers = new Headers();
  if (lastEventId !== undefined) headers.set("last-event-id", lastEventId);
  return await gateway.fetch(new Request(`${ORIGIN}/admin/api/v1/events/stream`, {
    headers,
    ...(signal === undefined ? {} : { signal }),
  }));
}

function decode(value: Uint8Array | undefined): string {
  return new TextDecoder().decode(value);
}
