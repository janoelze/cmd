import { createHmac } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { workbenchCatalog } from "./src/renderer/src/workbench/catalog/plugin.ts";

// xterm maps a mouse event to a cell from getBoundingClientRect() (screen px) and its
// cell size (layout px), so under a CSS scale() (the canvas zoom) selection, links and
// mouse reporting land on the wrong cells. Undo the element's scale where it does that.
// Excluded from dep pre-bundling below so this applies in dev too (as is the WebGL addon's patch).
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

// xterm's scrollbar re-arms its hide timer (clearTimeout + setTimeout) on every scroll, which
// is every line a busy terminal prints: ~40 ms a second of timers in a flood. One timer per
// hold instead, which looks again when it fires (as scrolled() in @cmd/ui does).
const XTERM_SCROLLBAR_HIDE = "_scheduleHide(){!this._mouseIsOver&&!this._isDragging&&this._hideTimeout.cancelAndSet(()=>this._hide(),Ma)}";
function xtermScrollbarHide(): Plugin {
  return {
    name: "xterm-scrollbar-hide",
    transform(code, id) {
      if (!/@xterm[/+]xterm.*[/]lib[/]xterm\.mjs$/.test(id)) return;
      if (!code.includes(XTERM_SCROLLBAR_HIDE)) throw new Error("xterm-scrollbar-hide: _scheduleHide changed, update the patch");
      return code.replace(
        XTERM_SCROLLBAR_HIDE,
        "_scheduleHide(){if(this._mouseIsOver||this._isDragging)return;this._hideAt=performance.now()+Ma;if(this._hideArmed)return;this._hideArmed=!0;const t=()=>{const l=this._hideAt-performance.now();if(l>0)return void this._hideTimeout.cancelAndSet(t,l);this._hideArmed=!1,this._hide()};this._hideTimeout.cancelAndSet(t,Ma)}",
      );
    },
  };
}

// xterm refreshes the selection after every scroll, selected or not, and the DOM renderer
// (terminals past the WebGL pool) answers each with a redraw of every row, measuring each
// char's width: a terminal that streams output redrew its whole screen every frame. Nothing
// selected before or now: nothing to redraw.
const XTERM_DOM_SELECTION = "handleSelectionChanged(e,i,r){if(this._selectionContainer.replaceChildren(),";
function xtermDomSelection(): Plugin {
  return {
    name: "xterm-dom-selection",
    transform(code, id) {
      if (!/@xterm[/+]xterm.*[/]lib[/]xterm\.mjs$/.test(id)) return;
      if (!code.includes(XTERM_DOM_SELECTION)) throw new Error("xterm-dom-selection: the DOM renderer's handleSelectionChanged changed, update the patch");
      return code.replace(XTERM_DOM_SELECTION, "handleSelectionChanged(e,i,r){if(!(e&&i)&&!this._hadSelection)return;if(this._hadSelection=!!(e&&i),this._selectionContainer.replaceChildren(),");
    },
  };
}

// The WebGL addon sizes its canvas to the cells' device pixels (cols × cell width, maybe
// odd), its CSS size to that over the pixel ratio, rounded, and a ResizeObserver then sets
// the canvas to the device pixels of that CSS size: one more when the first was odd. So
// every resize allocated and drew the canvas twice. Size it to what the observer will say.
const WEBGL_CANVAS_SIZE = "this._canvas.width=this.dimensions.device.canvas.width,this._canvas.height=this.dimensions.device.canvas.height,";
function xtermWebglCanvasSize(): Plugin {
  return {
    name: "xterm-webgl-canvas-size",
    transform(code, id) {
      if (!/@xterm[/+]addon-webgl.*[/]lib[/]addon-webgl\.mjs$/.test(id)) return;
      if (!code.includes(WEBGL_CANVAS_SIZE)) throw new Error("xterm-webgl-canvas-size: handleResize changed, update the patch");
      return code.replace(
        WEBGL_CANVAS_SIZE,
        "this._canvas.width=Math.round(this.dimensions.css.canvas.width*this._devicePixelRatio),this._canvas.height=Math.round(this.dimensions.css.canvas.height*this._devicePixelRatio),",
      );
    },
  };
}

// pdf.js loads what it needs for some PDFs on demand (windows/pdf/PdfView.tsx): character
// maps for CJK text, the standard 14 fonts, wasm image decoders (JPEG 2000, JBIG2) and
// colour profiles. Served at /pdfjs/<dir>/ in dev, copied to out/renderer/pdfjs/ in builds.
const PDFJS_DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];
function pdfjsAssets(): Plugin {
  const root = resolve(import.meta.dirname, "node_modules/pdfjs-dist");
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs/", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]!).replace(/^\/+/, "");
        const [dir] = rel.split("/");
        const file = join(root, rel);
        if (!PDFJS_DIRS.includes(dir!) || !file.startsWith(root) || !statSync(file, { throwIfNoEntry: false })?.isFile()) return next();
        if (file.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const dir of PDFJS_DIRS)
        for (const name of readdirSync(join(root, dir)))
          this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${name}`, source: readFileSync(join(root, dir, name)) });
    },
  };
}

// The app's version, read here only: What's New (__APP_VERSION__) and the usage stats key
// take it from this, and the packaged app's app.getVersion() from the same package.json.
// On a tag, CI makes it the tag's version first (scripts/release-version.mjs).
const APP_VERSION = (JSON.parse(readFileSync(resolve(import.meta.dirname, "package.json"), "utf8")) as { version: string }).version;

// The usage stats key of this version (core/usage.ts): from $CMD_USAGE_SECRET (a CI
// secret, tagged releases only), which the server holds too and derives the same key from.
function usageKey(): string {
  const secret = process.env.CMD_USAGE_SECRET;
  if (!secret) return "";
  return createHmac("sha256", secret).update(`cmd-usage:${APP_VERSION}`).digest("hex");
}

// @cmd/protocol and @cmd/ui ship TypeScript source, so they must be bundled, not externalized.
const bundleWorkspace = { externalizeDeps: { exclude: ["@cmd/protocol"] } };

export default defineConfig({
  // The packaged app ships no node_modules for main: Lucide's icons (@cmd/ui/lucide),
  // electron-updater, and the Visualizer's and Jam's libraries (as text, main/frames.ts) are bundled too.
  // The crash report and feedback webhooks (main/crash.ts, main/feedback.ts) and the
  // usage stats key come from the environment at build time (CI secrets), so they
  // aren't in the repository.
  main: {
    define: {
      __CRASH_WEBHOOK__: JSON.stringify(process.env.CMD_CRASH_WEBHOOK ?? ""),
      __FEEDBACK_WEBHOOK__: JSON.stringify(process.env.CMD_FEEDBACK_WEBHOOK ?? ""),
      __USAGE_KEY__: JSON.stringify(usageKey()),
    },
    build: { externalizeDeps: { exclude: ["@cmd/protocol", "@cmd/ui", "lucide-static", "electron-updater", "butterchurn", "butterchurn-presets", "@strudel/web"] } },
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
  // The app's version for What's New.
  renderer: {
    define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
    // The UI Workbench's catalog (docs/48), dev server only.
    plugins: [react(), xtermScaledCoords(), xtermScrollbarHide(), xtermDomSelection(), xtermWebglCanvasSize(), pdfjsAssets(), workbenchCatalog(resolve(import.meta.dirname, "../.."))],
    optimizeDeps: { exclude: ["@xterm/xterm", "@xterm/addon-webgl"] },
    build: {
      // CMD_NO_MINIFY=1: readable function names in profiles (e2e/latency.mjs --profile).
      minify: !process.env.CMD_NO_MINIFY,
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, "src/renderer/index.html"), settings: resolve(import.meta.dirname, "src/renderer/settings.html") },
      },
    },
  },
});
