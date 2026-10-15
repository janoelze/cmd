// What a built-in widget package ships (scripts/stage-runtime.mjs stages each of packages/widgets/*):
// package.json, README.md and LICENSE, and what its package.json's `files` lists (a file, or a
// folder copied whole), the way npm packs it. Never node_modules or a dot-file or dot-folder
// (.cmd-preview), at any depth. Staging fails loudly when `files` is missing, names something
// that isn't there or isn't plain (a glob, `..`, an absolute path), or leaves out what the
// package runs: a widget's `main`, and a frame widget's view.html.
import fs from "node:fs";
import path from "node:path";

const ALWAYS = ["package.json", "README.md", "LICENSE"];

/** A relative path inside the package with no glob, `..`, dot-segment or node_modules; else null. */
function plain(entry) {
  if (typeof entry !== "string" || !entry.trim() || path.isAbsolute(entry) || /[*?[\]{}!]/.test(entry)) return null;
  const segs = entry.split("/").filter((s) => s && s !== ".");
  if (!segs.length || segs.some((s) => s === ".." || s.startsWith(".") || s === "node_modules")) return null;
  return segs.join("/");
}

/** The files a built-in at `dir` ships, relative to it, sorted. Throws, naming the package, on anything amiss. */
export function widgetShipFiles(dir) {
  const name = path.basename(dir);
  const fail = (why) => {
    throw new Error(`packages/widgets/${name}: ${why}`);
  };
  const pkgFile = path.join(dir, "package.json");
  if (!fs.existsSync(pkgFile)) fail("no package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  if (!Array.isArray(pkg.files) || !pkg.files.length) fail(`package.json lists no "files": say what ships`);
  const out = new Set();
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    const st = fs.statSync(abs);
    if (st.isFile()) return void out.add(rel);
    for (const e of fs.readdirSync(abs)) if (!e.startsWith(".") && e !== "node_modules") walk(`${rel}/${e}`);
  };
  for (const entry of pkg.files) {
    const rel = plain(entry);
    if (!rel) fail(`"files" lists ${JSON.stringify(entry)}: name a file or folder of the package (no glob, "..", dot-file or node_modules)`);
    if (!fs.existsSync(path.join(dir, rel))) fail(`"files" lists ${rel}, which isn't there`);
    walk(rel);
  }
  for (const f of ALWAYS) if (fs.existsSync(path.join(dir, f))) out.add(f);
  for (const w of pkg.cmd?.widgets ?? []) {
    const main = typeof w.main === "string" ? plain(w.main) : null;
    if (main && !out.has(main)) fail(`widget ${w.id}'s main ${main} isn't in "files"`);
    if (w.surface === "frame" && !out.has("view.html")) fail(`widget ${w.id} draws in a frame, but view.html isn't in "files"`);
  }
  return [...out].sort();
}

/** Copy what the built-in at `from` ships into `to` (a new folder). */
export function stageWidgetPackage(from, to) {
  for (const rel of widgetShipFiles(from)) {
    fs.mkdirSync(path.dirname(path.join(to, rel)), { recursive: true });
    fs.copyFileSync(fs.realpathSync(path.join(from, rel)), path.join(to, rel));
  }
}
