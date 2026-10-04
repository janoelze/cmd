import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

// xterm maps a mouse event to a cell from getBoundingClientRect() (screen px) and its
// cell size (layout px), so under a CSS scale() (the canvas zoom) selection, links and
// mouse reporting land on the wrong cells. Undo the element's scale where it does that.
// Excluded from dep pre-bundling below so this applies in dev too.
const XTERM_COORDS = "return[t.clientX-i.left-n,t.clientY-i.top-o]}";
function xtermScaledCoords(): Plugin {
  return {
    name: "xterm-scaled-coords",
    transform(code, id) {
      if (!/@xterm[/+]xterm.*[/]lib[/]xterm\.mjs$/.test(id)) return;
      if (!code.includes(XTERM_COORDS)) throw new Error("xterm-scaled-coords: getCoordsRelativeToElement changed, update the patch");
      return code.replace(
        XTERM_COORDS,
        "return[(t.clientX-i.left)/(e.offsetWidth?i.width/e.offsetWidth:1)-n,(t.clientY-i.top)/(e.offsetHeight?i.height/e.offsetHeight:1)-o]}",
      );
    },
  };
}

// @cmd/protocol and @cmd/ui ship TypeScript source, so they must be bundled, not externalized.
const bundleWorkspace = { externalizeDeps: { exclude: ["@cmd/protocol"] } };

export default defineConfig({
  // The packaged app ships no node_modules for main: Lucide's icons (@cmd/ui/lucide) and
  // electron-updater are bundled too.
  // The crash report and feedback webhooks (main/crash.ts, main/feedback.ts) come
  // from the environment at build time (CI secrets), so they aren't in the repository.
  main: {
    define: {
      __CRASH_WEBHOOK__: JSON.stringify(process.env.CMD_CRASH_WEBHOOK ?? ""),
      __FEEDBACK_WEBHOOK__: JSON.stringify(process.env.CMD_FEEDBACK_WEBHOOK ?? ""),
    },
    build: { externalizeDeps: { exclude: ["@cmd/protocol", "@cmd/ui", "lucide-static", "electron-updater"] } },
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
  // The app's version for What's New (CI's release tags have bumped package.json).
  renderer: {
    define: { __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")).version) },
    plugins: [react(), xtermScaledCoords()],
    optimizeDeps: { exclude: ["@xterm/xterm"] },
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
