// What a built-in widget package ships (scripts/stage-runtime.mjs stages each of packages/widgets/*):
// package.json, README.md and LICENSE, and what its package.json's `files` lists, never
// node_modules or a dot-folder (.cmd-preview); the rules are core widgets/shipped.ts, which
// `cmd widget check` warns with. Staging fails loudly, naming the package, when `files` is
// missing or anything in it is amiss: a listed file that isn't there, a widget's `main` or a
// frame widget's view.html left out, a shipped script importing a file that doesn't ship.
import fs from "node:fs";
import path from "node:path";
import { shippedFiles } from "../packages/core/src/widgets/shipped.ts";

/** The files a built-in at `dir` ships, relative to it, sorted. Throws, naming the package, on anything amiss. */
export function widgetShipFiles(dir) {
  const name = path.basename(dir);
  if (!fs.existsSync(path.join(dir, "package.json"))) throw new Error(`packages/widgets/${name}: no package.json`);
  const s = shippedFiles(dir);
  if (!s) throw new Error(`packages/widgets/${name}: package.json lists no "files": say what ships`);
  if (s.problems.length) throw new Error(`packages/widgets/${name}: ${s.problems.join("; ")}`);
  return s.files;
}

/** Copy what the built-in at `from` ships into `to` (a new folder). */
export function stageWidgetPackage(from, to) {
  for (const rel of widgetShipFiles(from)) {
    fs.mkdirSync(path.dirname(path.join(to, rel)), { recursive: true });
    fs.copyFileSync(fs.realpathSync(path.join(from, rel)), path.join(to, rel));
  }
}
