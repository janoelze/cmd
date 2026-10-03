import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

// @cmd/protocol ships TypeScript source, so it must be bundled, not externalized.
const bundleWorkspace = { externalizeDeps: { exclude: ["@cmd/protocol"] } };

export default defineConfig({
  // The packaged app ships no node_modules for main: Lucide's icons and
  // electron-updater are bundled too.
  // The crash report webhook (main/crash.ts) comes from the environment at build
  // time (a CI secret), so it isn't in the repository.
  main: {
    define: { __CRASH_WEBHOOK__: JSON.stringify(process.env.CMD_CRASH_WEBHOOK ?? "") },
    build: { externalizeDeps: { exclude: ["@cmd/protocol", "lucide-static", "electron-updater"] } },
  },
  // Two preloads: the app's (index) and browser pages' (guest). CommonJS, because
  // browser pages are sandboxed and sandboxed preloads can't be ES modules.
  preload: {
    build: {
      ...bundleWorkspace,
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/preload/index.ts"), guest: resolve(import.meta.dirname, "src/preload/guest.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  // electron-vite leaves minification off; the renderer bundle is parsed on every launch.
  // Two pages: the app (index.html) and the Settings window (settings.html).
  renderer: {
    plugins: [react()],
    build: {
      minify: true,
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/renderer/index.html"), settings: resolve(import.meta.dirname, "src/renderer/settings.html") },
      },
    },
  },
});
