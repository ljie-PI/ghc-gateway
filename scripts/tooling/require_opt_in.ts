import { fileURLToPath } from "node:url";
import path from "node:path";

export function assertOptIn(variable: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env[variable] === "1") {
    return;
  }

  const command = "npm run test:sdk";
  throw new Error(`${command} is manual-only; set ${variable}=1 to run it.`);
}

async function main(): Promise<void> {
  const variable = process.argv[2];

  if (variable === undefined) {
    console.error("usage: require_opt_in.ts <ENV_VAR>");
    process.exit(2);
  }

  try {
    assertOptIn(variable);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
