import { writeFileSync } from "node:fs";

let configuration;
let ownerRequestedByFacade = false;

export function initialize(data) {
  configuration = data;
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (specifier === "./stream_execution_owner.js"
    && context.parentURL === configuration.facadeUrl
    && resolved.url === configuration.ownerUrl) {
    ownerRequestedByFacade = true;
  }
  return resolved;
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!ownerRequestedByFacade || url !== configuration.ownerUrl) {
    return loaded;
  }

  writeFileSync(configuration.blockedPath, "", { flag: "wx" });
  if (configuration.mode === "reject") {
    throw new Error(configuration.privateMarker);
  }

  const source = typeof loaded.source === "string"
    ? loaded.source
    : new TextDecoder().decode(loaded.source);
  const gate = JSON.stringify(configuration.releasePath);
  const prefix = [
    'import { existsSync as __ghcgOwnerGateExists } from "node:fs";',
    "const __ghcgOwnerGateDeadline = Date.now() + 10_000;",
    `while (!__ghcgOwnerGateExists(${gate})) {`,
    "  if (Date.now() >= __ghcgOwnerGateDeadline) throw new Error(\"stream owner loader gate timed out\");",
    "  await new Promise((resolve) => setImmediate(resolve));",
    "}",
  ].join("\n");
  return { ...loaded, source: `${prefix}\n${source}` };
}
