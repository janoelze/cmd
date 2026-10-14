// virtual:workbench-catalog in the renderer's dev server (docs/48): the catalog that
// extract.ts reads from the sources, and a loader per story file. Re-read when a
// component or story file changes; the module (and the UI Workbench) updates only when
// what it says changed, so editing a component's look stays a plain HMR update.

import path from "node:path";
import type { Plugin, ViteDevServer } from "vite";
import type { CatalogRoots, SourceCache } from "./extract.ts";

const ID = "virtual:workbench-catalog";
const RESOLVED = "\0" + ID;

export function workbenchCatalog(repo: string): Plugin {
  // Loaded on first use, so builds and the app's own dev page never load TypeScript.
  let x: (typeof import("./extract.ts")) | undefined;
  let roots: CatalogRoots | undefined;
  let cache: SourceCache | undefined;
  let code: string | null = null;
  let timer: NodeJS.Timeout | undefined;

  const build = () => {
    const catalog = x!.extractCatalog(roots!, cache);
    const fsPath = (f: string) => JSON.stringify("/@fs" + path.join(repo, f));
    // A widget package's story is its widget and the fake host's data per variant: widgetStory.tsx makes them components.
    const load = (s: { id: string; file: string }) =>
      x!.widgetStoryOf(path.join(repo, s.file), roots!)
        ? `Promise.all([import(${fsPath(s.file)}), import(${fsPath(path.join(path.dirname(path.dirname(s.file)), "package.json"))}), import(${fsPath("apps/desktop/src/renderer/src/workbench/widgetStory.tsx")})]).then(([m, p, w]) => w.widgetStory(m, p.default, ${JSON.stringify(path.basename(s.file, ".story.tsx"))}))`
        : `import(${fsPath(s.file)})`;
    const loaders = catalog.stories.map((s) => `  ${JSON.stringify(s.id)}: () => ${load(s)},`);
    return `export const catalog = ${JSON.stringify(catalog)};\nexport const loaders = {\n${loaders.join("\n")}\n};\n`;
  };
  const outside = () => (roots ? [...x!.widgetPackages(roots).values()].filter((d) => !d.startsWith(repo + path.sep)) : []);
  const relevant = (file: string) => !!roots && /\.tsx?$/.test(file) && (file.startsWith(roots.kit) || file.startsWith(roots.renderer) || file.startsWith(roots.widgets) || outside().some((d) => file.startsWith(d + path.sep)));
  /** The person's widget packages outside the checkout (~/.cmd/widgets, linked folders), found when the server starts. */
  let theirs: string[] = [];

  const changed = (server: ViteDevServer, file: string) => {
    if (!relevant(file)) return;
    cache!.forget(file);
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (code === null) return;
      let next: string;
      try {
        next = build();
      } catch (err) {
        server.config.logger.error(`workbench catalog: ${String(err)}`);
        return;
      }
      // Only what the catalog says counts, not how long it took.
      const strip = (c: string) => c.replace(/"ms":\d+/, "");
      if (strip(next) === strip(code)) return;
      code = next;
      const mod = server.moduleGraph.getModuleById(RESOLVED);
      if (mod) void server.reloadModule(mod);
    }, 150);
  };

  // When the dev server last handled a changed file, and last sent the page an update for
  // one: scripts/workbench.mjs reads them (/__workbench/hmr) to wait for an edit to land.
  const hmr = { heard: 0, sent: 0 };

  return {
    name: "workbench-catalog",
    handleHotUpdate({ modules }) {
      hmr.heard = Date.now();
      if (modules.length) hmr.sent = hmr.heard;
    },
    apply: "serve",
    // The person's packages (cmd widget dev, docs/56) live outside the checkout: the dev server may
    // serve them, and what they import of the widget API and React is the checkout's, as in the
    // widget process (an installed package has no node_modules of its own).
    async config(_config, env) {
      if (env.command !== "serve") return;
      x ??= await import("./extract.ts");
      roots ??= x.catalogRoots(repo);
      cache ??= new x.SourceCache();
      theirs = outside();
      return theirs.length ? { server: { fs: { allow: [repo, ...theirs] } } } : undefined;
    },
    async resolveId(id, importer) {
      if (id === ID) return RESOLVED;
      if (!importer || !theirs.some((d) => importer.startsWith(d + path.sep))) return undefined;
      if (/^(@cmd\/widget-api|react)(\/|$)/.test(id)) return this.resolve(id, path.join(repo, "packages/widget-api/src/index.ts"), { skipSelf: true });
      return undefined;
    },
    async load(id) {
      if (id !== RESOLVED) return undefined;
      x ??= await import("./extract.ts");
      roots ??= x.catalogRoots(repo);
      cache ??= new x.SourceCache();
      code ??= build();
      return code;
    },
    configureServer(server) {
      // The kit is outside the renderer's root: watch it for new story files too.
      server.watcher.add(path.join(repo, "packages/ui/src"));
      server.watcher.add(path.join(repo, "packages/widgets"));
      for (const d of theirs) server.watcher.add(path.join(d, "src"));
      server.middlewares.use("/__workbench/hmr", (_req, res) => (res.setHeader("Content-Type", "application/json"), res.end(JSON.stringify(hmr))));
      for (const ev of ["add", "change", "unlink"] as const) server.watcher.on(ev, (file) => changed(server, file));
    },
  };
}
