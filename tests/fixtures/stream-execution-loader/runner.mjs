import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const mode = process.argv[2];
const outputRoot = process.argv[3];
const privateMarker = process.env.GHCG_STREAM_OWNER_PRIVATE_MARKER;
const gatePath = process.env.GHCG_STREAM_OWNER_GATE_PATH;
if (!["delay", "reject"].includes(mode)
  || outputRoot === undefined
  || privateMarker === undefined
  || gatePath === undefined) {
  throw new Error("invalid stream owner runner fixture configuration");
}

const importOutput = async (relativePath) => await import(pathToFileURL(
  path.join(outputRoot, relativePath),
).href);
const [{ defaultRuntimeConfigSnapshot }, { parseStartupConfig }, gatewayModule, streamModule] = await Promise.all([
  importOutput("src/config/schema.js"),
  importOutput("src/config/startup_config.js"),
  importOutput("src/gateway/create_gateway.js"),
  importOutput("src/gateway/stream_execution.js"),
]);

let detachedRejections = 0;
process.on("unhandledRejection", () => {
  detachedRejections += 1;
});

const waitForFile = async (filePath) => {
  const deadline = Date.now() + 10_000;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error("stream owner runner gate timed out");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
};
const runtime = defaultRuntimeConfigSnapshot();
runtime.admission.activeMax = 1;
runtime.admission.queueMax = 0;
runtime.timeouts.totalMs = 123;
let releaseTotalTimeout;
let signalAbortedResolve;
const signalAborted = new Promise((resolve) => {
  signalAbortedResolve = resolve;
});
let totalTimeoutArmedResolve;
const totalTimeoutArmed = new Promise((resolve) => {
  totalTimeoutArmedResolve = resolve;
});
const counts = {
  cancel: 0,
  iteratorCreated: 0,
  iteratorNext: 0,
  iteratorReturn: 0,
  terminal: 0,
};
let ownerObservedAlreadyAborted = false;
let routeCalls = 0;
const route = {
  method: "POST",
  path: "/v1/loader-lifecycle",
  admission: "inference",
  body: "none",
  presentFailure: (failure) => new Response(JSON.stringify({ kind: failure.kind }), {
    status: failure.kind === "upstream_timeout" ? 504 : 500,
    headers: { "content-type": "application/json" },
  }),
  endpoint: async (_request, scope) => {
    routeCalls += 1;
    if (routeCalls > 1) {
      return new Response("next");
    }
    if (scope.signal.aborted) {
      signalAbortedResolve();
    } else {
      scope.signal.addEventListener("abort", signalAbortedResolve, { once: true });
    }
    return await streamModule.createStreamExecutionResponse({
      upstream: {
        status: 200,
        headers: new Headers(),
        bytes: { async *[Symbol.asyncIterator]() { yield new Uint8Array(); } },
        cancel: async () => { counts.cancel += 1; },
      },
      emissions: {
        [Symbol.asyncIterator]() {
          counts.iteratorCreated += 1;
          ownerObservedAlreadyAborted = scope.signal.aborted;
          return {
            next: async () => {
              counts.iteratorNext += 1;
              return await new Promise(() => undefined);
            },
            return: async () => {
              counts.iteratorReturn += 1;
              return { done: true, value: undefined };
            },
          };
        },
      },
      signal: scope.signal,
      deliverySignal: scope.deliverySignal,
      normalizeFailure: (error) => error,
      onTerminal: () => { counts.terminal += 1; },
    });
  },
};
const gateway = await gatewayModule.createGateway({
  startup: parseStartupConfig([], {}, { homedir: process.cwd() }),
  runtime,
}, [route], {
  admin: {
    handle: (_request, context) => Promise.resolve(new Response(
      JSON.stringify(context.activity.snapshot()),
    )),
    mintBootstrap: () => ({ kind: "closed" }),
    close: () => undefined,
  },
  delay: async (ms, signal) => {
    if (ms !== runtime.timeouts.totalMs) {
      throw new Error("unexpected fixture delay");
    }
    totalTimeoutArmedResolve();
    await new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      releaseTotalTimeout = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  },
});

let response;
let responseSettled = false;
let settledBeforeRelease = false;
let settledAfterAbort = false;
let loaderInterceptions = 0;
try {
  const pendingResponse = gateway.fetch(new Request(
    `http://127.0.0.1:31400/v1/loader-lifecycle?private=${encodeURIComponent(privateMarker)}`,
    { method: "POST", headers: { "x-private-fixture": privateMarker } },
  ));
  void pendingResponse.then(
    () => { responseSettled = true; },
    () => { responseSettled = true; },
  );
  await waitForFile(`${gatePath}.blocked`);
  loaderInterceptions += 1;
  settledBeforeRelease = responseSettled;

  if (mode === "delay") {
    await totalTimeoutArmed;
    releaseTotalTimeout();
    await signalAborted;
    settledAfterAbort = responseSettled;
    writeFileSync(`${gatePath}.release`, "", { flag: "wx" });
  }

  response = await pendingResponse;
  const responseBody = await response.text();
  const handlePresent = streamModule.getStreamExecutionHandle(response) !== undefined;
  const nextResponse = await gateway.fetch(new Request(
    "http://127.0.0.1:31400/v1/loader-lifecycle",
    { method: "POST" },
  ));
  const nextBody = await nextResponse.text();
  const activityResponse = await gateway.fetch(new Request("http://127.0.0.1:31400/admin/api/v1/activity"));
  const activity = await activityResponse.json();
  await new Promise((resolve) => setImmediate(resolve));

  process.stdout.write(`${JSON.stringify({
    activity,
    counts,
    detachedRejections,
    handlePresent,
    loaderInterceptions,
    nextBody,
    nextStatus: nextResponse.status,
    ownerObservedAlreadyAborted,
    responseBody,
    responseStatus: response.status,
    settledAfterAbort,
    settledBeforeRelease,
  })}\n`);
} finally {
  if (mode === "delay") {
    writeFileSync(`${gatePath}.release`, "", { flag: "a" });
  }
  await gateway.close();
}
