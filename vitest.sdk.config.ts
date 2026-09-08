import { defineConfig } from "vitest/config";

const offline = process.env.GHC_GATEWAY_SDK_TESTS === "1";

if (!offline) {
  throw new Error("GHC_GATEWAY_SDK_TESTS=1 is required for official SDK tests");
}

export default defineConfig({
  test: {
    name: "offline-sdk",
    include: ["tests/sdk/**/*.sdk.test.ts"],
    exclude: ["node_modules/**"],
    globals: true,
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
