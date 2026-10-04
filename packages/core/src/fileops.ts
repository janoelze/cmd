// File operations for file windows: rename, duplicate, new file or folder.
// None overwrites: rename fails when the name is taken, the others pick a free
// name the way Finder does ("a copy.txt", "a copy 2.txt", "untitled folder 2").
// Moving to the Trash is the app's (Electron's shell.trashItem).

import fs from "node:fs";
import path from "node:path";
import { expandHome } from "./windows/builtin.ts";

const abs = (p: string) => path.resolve(expandHome(p));

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
  const name = path.basename(from);
  // Folders and dotfiles (".env") have no extension to keep at the end.
  const ext = isDir ? "" : path.extname(name);
  const target = freeName(path.dirname(from), `${name.slice(0, name.length - ext.length)} copy`, ext);
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
