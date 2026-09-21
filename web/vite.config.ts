import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  base: "/",
  plugins: [svelte()],
  build: {
    outDir: "../dist/admin",
    emptyOutDir: false,
    manifest: true,
  },
});
