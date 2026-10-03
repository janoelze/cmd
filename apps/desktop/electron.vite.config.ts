import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

// @cmd/protocol ships TypeScript source, so it must be bundled, not externalized.
const bundleWorkspace = { externalizeDeps: { exclude: ["@cmd/protocol"] } };

export default defineConfig({
  main: { build: bundleWorkspace },
  preload: { build: bundleWorkspace },
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
