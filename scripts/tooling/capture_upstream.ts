import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseStartupConfig } from "../../src/config/startup_config.js";
import { createProductionApplicationContext } from "../../src/main.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "data-dir": { type: "string" },
      account: { type: "string" },
      model: { type: "string", default: "gemini-3.5-flash" },
      protocol: { type: "string", default: "chat" },
      stream: { type: "boolean", default: false },
      prompt: { type: "string", default: "Hello, reply pong." },
      out: { type: "string" },
      "dry-run": { type: "boolean", default: true },
    },
    strict: true,
  });

  const model = values.model!;
  const isStream = values.stream === true;
  const prompt = values.prompt!;
  const protocol = values.protocol!;

  console.log(`=== Capture Plan (${values["dry-run"] ? "DRY-RUN" : "EXECUTE"}) ===`);
  console.log(`Protocol: ${protocol}`);
  console.log(`Model:    ${model}`);
  console.log(`Stream:   ${isStream}`);
  console.log(`Prompt:   ${prompt}`);
  console.log(`Output:   ${values.out ?? "(stdout only)"}`);

  if (values["dry-run"]) {
    console.log("\nDry-run complete. Re-run with --no-dry-run to record real exchange.");
    return;
  }

  const dataDir = values["data-dir"] ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".ghc-gateway");
  const startup = parseStartupConfig(["--data-dir", dataDir], {});
  const ctx = await createProductionApplicationContext(startup, {});

  try {
    const defaultAcc = ctx.directory.list().find((a) => a.state === "active");
    const accountId = values.account ?? defaultAcc?.accountId;
    if (!accountId) {
      throw new Error("No active account available in data directory");
    }
    const account = await ctx.directory.bindAccount(accountId, new AbortController().signal);

    const copilot = await ctx.copilot.bind(account, new AbortController().signal);
    console.log(`Authenticated as ${account.accountId} via ${copilot.target.endpoint}`);

    if (protocol === "chat") {
      const reqBody = {
        model,
        messages: [{ role: "user", content: prompt }],
        stream: isStream,
        max_tokens: 32,
      };

      if (!isStream) {
        const resp = await copilot.completeChat({
          model,
          body: new TextEncoder().encode(JSON.stringify(reqBody)),
          stream: false,
          hasVisionInput: false,
          nonstreamBodyBytes: 10 * 1024 * 1024,
          connectTimeoutMs: 30_000,
          firstByteTimeoutMs: 60_000,
          signal: new AbortController().signal,
        });
        const sha256 = createHash("sha256").update(resp.body).digest("hex");
        console.log(`Status: ${resp.status}, Body length: ${resp.body.byteLength}, SHA-256: ${sha256}`);
        if (values.out) {
          await writeFile(values.out, resp.body);
          console.log(`Saved to ${values.out}`);
        }
      } else {
        const streamResp = await copilot.openChatStream({
          model,
          body: new TextEncoder().encode(JSON.stringify(reqBody)),
          stream: true,
          hasVisionInput: false,
          nonstreamBodyBytes: 10 * 1024 * 1024,
          connectTimeoutMs: 30_000,
          firstByteTimeoutMs: 60_000,
          signal: new AbortController().signal,
        });
        const chunks: Uint8Array[] = [];
        for await (const chunk of streamResp.bytes) {
          chunks.push(chunk);
        }
        const fullBody = Buffer.concat(chunks);
        const sha256 = createHash("sha256").update(fullBody).digest("hex");
        console.log(`Status: ${streamResp.status}, Stream bytes: ${fullBody.byteLength}, SHA-256: ${sha256}`);
        if (values.out) {
          await writeFile(values.out, fullBody);
          console.log(`Saved to ${values.out}`);
        }
      }
    } else {
      throw new Error(`Protocol ${protocol} not supported yet in recorder tool`);
    }
  } finally {
    if (ctx.close) {
      await ctx.close();
    }
  }
}

main().catch((err) => {
  console.error("Capture tool error:", err);
  process.exit(1);
});
