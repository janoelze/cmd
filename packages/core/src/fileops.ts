// File operations for file windows: rename, duplicate, new file or folder, and
// copy or move into a folder (drag and drop, docs/22-drag-and-drop.md).
// None overwrites: rename fails when the name is taken, the others pick a free
// name the way Finder does ("a copy.txt", "a copy 2.txt", "untitled folder 2",
// "a 2.txt" for a copy or move onto a taken name).
// Moving to the Trash is the app's (Electron's shell.trashItem).

import fs from "node:fs";
import path from "node:path";
import { expandHome } from "./windows/builtin.ts";

const abs = (p: string) => path.resolve(expandHome(p));

/** A name's base and extension; folders and dotfiles (".env") have no extension to keep at the end. */
function splitName(name: string, isDir: boolean): [string, string] {
  const ext = isDir ? "" : path.extname(name);
  return [name.slice(0, name.length - ext.length), ext];
}

/** `base` + `ext` in `dir`, or with " 2", " 3"… before the extension until it is free. */
function freeName(dir: string, base: string, ext: string): string {
  for (let n = 1; ; n++) {
    const p = path.join(dir, `${base}${n === 1 ? "" : ` ${n}`}${ext}`);
    if (!fs.existsSync(p)) return p;
  }
}

export function renamePath(p: string, name: string): string {
  const from = abs(p);
  const to = name.trim();
  if (!to || to === "." || to === ".." || to.includes("/")) throw new Error(`not a valid name: ${name}`);
  const target = path.join(path.dirname(from), to);
  if (target === from) return from;
  // A case-only rename on a case-insensitive disk finds the file itself under the new name.
  const taken = fs.existsSync(target) && fs.statSync(target).ino !== fs.statSync(from).ino;
  if (taken) throw new Error(`“${to}” already exists`);
  fs.renameSync(from, target);
  return target;
}

export function duplicatePath(p: string): string {
  const from = abs(p);
  const isDir = fs.statSync(from).isDirectory();
  const [base, ext] = splitName(path.basename(from), isDir);
  const target = freeName(path.dirname(from), `${base} copy`, ext);
  fs.cpSync(from, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  return target;
}

export function createPath(dir: string, kind: "file" | "dir"): string {
  const parent = abs(dir);
  const target = freeName(parent, kind === "dir" ? "untitled folder" : "untitled", "");
  if (kind === "dir") fs.mkdirSync(target);
  else fs.writeFileSync(target, "", { flag: "wx" });
  return target;
}

/**
 * Copy or move files and folders into `dir`; returns where each one ended up.
 * "auto" is Finder's plain drag: move on the same disk, copy from another.
 * A taken name gets " 2", " 3"… A move within the folder it's already in does
 * nothing; a folder can't go into itself. A move to another disk copies, then deletes.
 * Checks every path before touching any.
 */
export function transferPaths(paths: string[], dir: string, op: "copy" | "move" | "auto"): string[] {
  const into = abs(dir);
  const dest = fs.statSync(into);
  if (!dest.isDirectory()) throw new Error(`not a folder: ${dir}`);
  const from = paths.map(abs);
  for (const f of from) {
    fs.lstatSync(f); // throws ENOENT with the path
    if (into === f || into.startsWith(f + path.sep)) throw new Error(`“${path.basename(f)}” can't go into itself`);
  }
  return from.map((f) => {
    const how = op !== "auto" ? op : fs.lstatSync(f).dev === dest.dev ? "move" : "copy";
    if (how === "move" && path.dirname(f) === into) return f;
    const isDir = fs.lstatSync(f).isDirectory();
    const target = freeName(into, ...splitName(path.basename(f), isDir));
    if (how === "copy") {
      fs.cpSync(f, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
      return target;
    }
    try {
      fs.renameSync(f, target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      fs.cpSync(f, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
      fs.rmSync(f, { recursive: true, force: true });
    }
    return target;
  });
}
