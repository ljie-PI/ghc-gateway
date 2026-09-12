import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const gatePath = process.env.GHCG_STREAM_OWNER_GATE_PATH;
const outputRoot = process.env.GHCG_STREAM_OWNER_OUTPUT_ROOT;
const mode = process.env.GHCG_STREAM_OWNER_LOADER_MODE;
const privateMarker = process.env.GHCG_STREAM_OWNER_PRIVATE_MARKER;
if (gatePath === undefined
  || outputRoot === undefined
  || !["delay", "reject"].includes(mode)
  || privateMarker === undefined) {
  throw new Error("invalid stream owner loader fixture configuration");
}

register("./loader.mjs", import.meta.url, {
  data: {
    blockedPath: `${gatePath}.blocked`,
    facadeUrl: pathToFileURL(path.join(outputRoot, "src/gateway/stream_execution.js")).href,
    mode,
    ownerUrl: pathToFileURL(path.join(outputRoot, "src/gateway/stream_execution_owner.js")).href,
    privateMarker,
    releasePath: `${gatePath}.release`,
  },
});
