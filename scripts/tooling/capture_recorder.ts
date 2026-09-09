import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BoundCopilot } from "../../src/copilot/backend.js";
import { UpstreamBodyLimitError, UpstreamTimeoutError } from "../../src/copilot/transport.js";
import { MESSAGES_VERSION, type UpstreamByteStream } from "../../src/copilot/upstream_types.js";
import type { SemanticUsage } from "../../src/protocols/conversion/types.js";
import { CAPTURE_SCENARIOS, scenarioDefinition, type CaptureScenario } from "./capture_scenarios.js";
import { CAPTURE_MODELS, encodeCaptureRequest, forecastResults, validateCaptureResponse, type CaptureHistoryItem, type CaptureModel } from "./capture_protocol.js";

export interface CaptureOptions {
  readonly execute?: boolean;
  readonly model?: string;
  readonly protocol?: string;
  readonly scenario?: CaptureScenario | "all";
  readonly mode?: "nonstream" | "stream" | "both";
  readonly totalTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly signal?: AbortSignal;
}
export interface CaptureDependencies {
  // One Bound Account and one Copilot binding are held for the whole run.
  readonly bind: (signal: AbortSignal) => Promise<BoundCopilot>;
  readonly createUuid?: () => string;
}
export interface CaptureEvidence {
  readonly scenario: CaptureScenario;
  readonly mode: "nonstream" | "stream";
  readonly turn: number;
  readonly status: number;
  readonly terminal: "completed";
  readonly hasVisionInput: boolean;
  readonly toolCalls: number;
  readonly textCharacters: number;
  readonly textSha256: string;
  readonly semanticDeltas: number;
  readonly usage: SemanticUsage;
  readonly requestFile: string;
  readonly responseFile: string;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly requestSha256: string;
  readonly responseSha256: string;
}
interface CapturePlan {
  readonly model: CaptureModel;
  readonly protocol: "chat" | "responses" | "messages";
  readonly route: string;
  readonly requests: number;
  readonly totalTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxBodyBytes: number;
}
export type CaptureResult = (CapturePlan & { readonly executed: false }) | (CapturePlan & {
  readonly executed: true;
  readonly outputDirectory: string;
  readonly exchanges: readonly CaptureEvidence[];
});
type FailureCode = "capture_invalid_options" | "capture_invalid_response" | "capture_http_status" | "capture_timeout" | "capture_cancelled" | "capture_body_limit" | "capture_failed" | "capture_unsafe_destination" | "capture_cleanup_failed";
export class CaptureError extends Error {
  step?: { readonly scenario: CaptureScenario; readonly mode: "nonstream" | "stream"; readonly turn: number };
  constructor(readonly code: FailureCode, readonly status?: number) { super(code); this.name = "CaptureError"; }
}

export async function recordCapture(options: CaptureOptions, deps: CaptureDependencies): Promise<CaptureResult> {
  const model = options.model ?? "gemini-3.5-flash";
  const scenario = options.scenario ?? "all";
  const mode = options.mode ?? "both";
  if (!Object.hasOwn(CAPTURE_MODELS, model) || (scenario !== "all" && !CAPTURE_SCENARIOS.includes(scenario))
    || !["nonstream", "stream", "both"].includes(mode) || (options.execute !== undefined && typeof options.execute !== "boolean")) fail("capture_invalid_options");
  const configuredModel = model as CaptureModel;
  const config = CAPTURE_MODELS[configuredModel];
  if (options.protocol !== undefined && options.protocol !== config.protocol) fail("capture_invalid_options");
  const scenarios: readonly CaptureScenario[] = scenario === "all" ? CAPTURE_SCENARIOS : [scenario];
  const modes = mode === "both" ? ["nonstream", "stream"] as const : [mode];
  const plan: CapturePlan = {
    model: configuredModel, protocol: config.protocol, route: config.route,
    requests: scenarios.reduce((count, value) => count + scenarioDefinition(value).turns.length, 0) * modes.length,
    totalTimeoutMs: boundedOption(options.totalTimeoutMs, 1_200_000, 1_200_000),
    requestTimeoutMs: boundedOption(options.requestTimeoutMs, 180_000, 180_000),
    idleTimeoutMs: boundedOption(options.idleTimeoutMs, 30_000, 120_000),
    maxBodyBytes: boundedOption(options.maxBodyBytes, 8_388_608, 8_388_608),
  };
  if (options.execute !== true) return { executed: false, ...plan };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new CaptureError("capture_timeout")), plan.totalTimeoutMs);
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]);
  let reserved: string | undefined;
  let published = false;
  let step: CaptureError["step"];
  try {
    signal.throwIfAborted();
    const temporary = await realpath(tmpdir());
    const repository = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
    if (within(temporary, repository) || temporary.split(path.sep).some((part) => /^(?:artifacts|corpus)$/iu.test(part))) fail("capture_unsafe_destination");
    // No caller-selected filenames, no existing tree, no overwrite/promotion path.
    reserved = await mkdtemp(path.join(temporary, `ghcg-capture-${process.pid}-`));
    const staging = path.join(reserved, ".pending");
    await mkdir(staging, { mode: 0o700 });
    const image = scenarios.some((value) => scenarioDefinition(value).turns.some((turn) => turn.image))
      ? await referenceImage() : undefined;
    const bound = await waitFor(deps.bind(signal), signal);
    const exchanges: CaptureEvidence[] = [];
    for (const currentMode of modes) {
      for (const currentScenario of scenarios) {
        const definition = scenarioDefinition(currentScenario);
        const history: CaptureHistoryItem[] = [];
        for (const [index, turn] of definition.turns.entries()) {
          step = { scenario: currentScenario, mode: currentMode, turn: index + 1 };
          signal.throwIfAborted();
          history.push({ role: "user", text: turn.prompt, ...(turn.image ? { image: image! } : {}) });
          const hasVisionInput = history.some((item) => item.role === "user" && item.image !== undefined);
          const stream = currentMode === "stream";
          const request = encodeCaptureRequest(configuredModel, definition.system, history, stream, turn.tools);
          if (request.byteLength > 8_388_608) fail("capture_body_limit");
          const turnController = new AbortController();
          const turnTimer = setTimeout(() => turnController.abort(new CaptureError("capture_timeout")), plan.requestTimeoutMs);
          const turnSignal = AbortSignal.any([signal, turnController.signal]);
          let response: { status: number; body: Uint8Array };
          try {
            response = await exchange(bound, plan, request, stream, hasVisionInput,
              history.at(-2)?.role === "tool" ? "agent" : "user", deps.createUuid ?? randomUUID, turnSignal);
          } finally { clearTimeout(turnTimer); }
          let validated;
          try {
            validated = await validateCaptureResponse(config.protocol, response.body, stream, turn, plan.maxBodyBytes);
          } catch { fail("capture_invalid_response"); }
          signal.throwIfAborted();
          const basename = `${currentScenario}.${currentMode}.turn-${index + 1}`;
          const requestFile = `${basename}.request.json`;
          const responseFile = `${basename}.response.${stream ? "sse" : "json"}`;
          await writeFile(path.join(staging, requestFile), request, { flag: "wx", mode: 0o600 });
          await writeFile(path.join(staging, responseFile), response.body, { flag: "wx", mode: 0o600 });
          exchanges.push({
            scenario: currentScenario, mode: currentMode, turn: index + 1, status: response.status,
            terminal: validated.terminal, hasVisionInput, toolCalls: validated.assistant.calls.length,
            textCharacters: validated.textCharacters, textSha256: validated.textSha256, semanticDeltas: validated.semanticDeltas,
            usage: validated.usage, requestFile, responseFile,
            requestBytes: request.byteLength, responseBytes: response.body.byteLength,
            requestSha256: digest(request), responseSha256: digest(response.body),
          });
          history.push({ role: "assistant", ...validated.assistant });
          if (validated.assistant.calls.length) history.push(...forecastResults(validated.assistant.calls));
        }
      }
    }
    const outputDirectory = path.join(reserved, "capture");
    const result: CaptureResult = { executed: true, ...plan, outputDirectory, exchanges };
    await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    // Read back all staged bytes before the only publication point.
    for (const item of exchanges) {
      if (digest(await readFile(path.join(staging, item.requestFile))) !== item.requestSha256
        || digest(await readFile(path.join(staging, item.responseFile))) !== item.responseSha256) fail("capture_failed");
    }
    signal.throwIfAborted();
    await rename(staging, outputDirectory);
    signal.throwIfAborted();
    published = true;
    return result;
  } catch (error: unknown) {
    controller.abort();
    if (error instanceof CaptureError) {
      if (step !== undefined) error.step = step;
      throw error;
    }
    if (signal.aborted && signal.reason instanceof CaptureError) throw signal.reason;
    if (error instanceof UpstreamBodyLimitError) fail("capture_body_limit");
    if (error instanceof UpstreamTimeoutError) fail("capture_timeout");
    if (options.signal?.aborted === true) fail("capture_cancelled");
    return fail("capture_failed");
  } finally {
    clearTimeout(timer);
    if (!published && reserved !== undefined) {
      try { await rm(reserved, { recursive: true, force: true }); }
      catch { fail("capture_cleanup_failed"); }
    }
  }
}

async function exchange(bound: BoundCopilot, plan: CapturePlan, body: Uint8Array, stream: boolean, hasVisionInput: boolean,
  initiator: "user" | "agent", createUuid: () => string, signal: AbortSignal): Promise<{ status: number; body: Uint8Array }> {
  const limits = { body, nonstreamBodyBytes: plan.maxBodyBytes, connectTimeoutMs: 30_000, firstByteTimeoutMs: 60_000, signal };
  const chat = { ...limits, model: plan.model, stream, hasVisionInput };
  const responses = { ...limits, hasVisionInput, initiator, requestId: createUuid() };
  const messages = { ...limits, version: MESSAGES_VERSION, betaFeatures: [] };
  if (!stream) {
    const pending = plan.protocol === "chat" ? bound.completeChat(chat)
      : plan.protocol === "responses" ? bound.completeResponses(responses) : bound.completeMessages(messages);
    const response = await waitFor(pending, signal);
    validateHeaders(response.status, response.headers, false);
    if (response.body.byteLength > plan.maxBodyBytes) fail("capture_body_limit");
    return response;
  }
  const pending = plan.protocol === "chat" ? bound.openChatStream(chat)
    : plan.protocol === "responses" ? bound.openResponsesStream(responses) : bound.openMessagesStream(messages);
  // A late header result after cancellation must not retain an unowned stream.
  void pending.then(async (late) => { if (signal.aborted) await late.cancel(); }).catch(() => undefined);
  const response = await waitFor(pending, signal);
  try {
    validateHeaders(response.status, response.headers, true);
    return { status: response.status, body: await readStream(response, plan, signal) };
  } finally {
    await waitFor(response.cancel(), AbortSignal.timeout(3_000)).catch(() => undefined);
  }
}
async function readStream(response: UpstreamByteStream, plan: CapturePlan, signal: AbortSignal): Promise<Uint8Array> {
  // A fixed byte budget also bounds metadata under one-byte chunking.
  const bytes = Buffer.allocUnsafe(plan.maxBodyBytes);
  let count = 0;
  const iterator = response.bytes[Symbol.asyncIterator]();
  for (;;) {
    const idle = new AbortController();
    const timer = setTimeout(() => idle.abort(new CaptureError("capture_timeout")), plan.idleTimeoutMs);
    let next: IteratorResult<Uint8Array>;
    try { next = await waitFor(iterator.next(), AbortSignal.any([signal, idle.signal])); }
    finally { clearTimeout(timer); }
    if (next.done === true) break;
    count += next.value.byteLength;
    if (count > plan.maxBodyBytes) fail("capture_body_limit");
    bytes.set(next.value, count - next.value.byteLength);
  }
  return bytes.subarray(0, count);
}
function validateHeaders(status: number, headers: Headers, stream: boolean): void {
  if (status !== 200) throw new CaptureError("capture_http_status", Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined);
  const type = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== (stream ? "text/event-stream" : "application/json")) fail("capture_invalid_response");
}
async function referenceImage(): Promise<string> {
  const handle = await open(new URL("../../tests/sdk/images/vergil.jpg", import.meta.url), "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 2_097_152) fail("capture_body_limit");
    const image = Buffer.alloc(stat.size);
    const result = await handle.read(image, 0, image.length, 0);
    if (result.bytesRead !== image.length || digest(image) !== "09cd595db8c42f401f34904574235856719e432d7466f4585f24bf00eeb0d7a2") fail("capture_invalid_options");
    return image.toString("base64");
  } finally { await handle.close(); }
}
async function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let remove = (): void => undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal.reason instanceof CaptureError ? signal.reason : new CaptureError("capture_cancelled"));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      remove = () => signal.removeEventListener("abort", abort);
    })]);
  } finally { remove(); }
}
function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  const chosen = value ?? fallback;
  if (!Number.isSafeInteger(chosen) || chosen < 1 || chosen > maximum) fail("capture_invalid_options");
  return chosen;
}
function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
function digest(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function fail(code: FailureCode): never { throw new CaptureError(code); }
