import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

// @cmd/protocol ships TypeScript source, so it must be bundled, not externalized.
const bundleWorkspace = { externalizeDeps: { exclude: ["@cmd/protocol"] } };

export default defineConfig({
  // The packaged app ships no node_modules for main: Lucide's icons and
  // electron-updater are bundled too.
  // The crash report and feedback webhooks (main/crash.ts, main/feedback.ts) come
  // from the environment at build time (CI secrets), so they aren't in the repository.
  main: {
    define: {
      __CRASH_WEBHOOK__: JSON.stringify(process.env.CMD_CRASH_WEBHOOK ?? ""),
      __FEEDBACK_WEBHOOK__: JSON.stringify(process.env.CMD_FEEDBACK_WEBHOOK ?? ""),
    },
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
  // Three pages: the app (index.html), the Settings window (settings.html) and the Task Manager (tasks.html).
  renderer: {
    plugins: [react()],
    build: {
      minify: true,
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/renderer/index.html"), settings: resolve(import.meta.dirname, "src/renderer/settings.html"),
          tasks: resolve(import.meta.dirname, "src/renderer/tasks.html"),
        },
      },
    },
  },
});
