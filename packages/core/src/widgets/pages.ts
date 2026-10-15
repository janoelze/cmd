// A Frame's page (API 1.2; docs/56, the Frame element): an .html file of its package, named by
// the element's `src`. Whether one is there (the host tells `cmd widget dev` once when a tree
// names one that isn't, host/frame.ts), and the ones a package's source names that aren't
// (`cmd widget check` warns: a typo, or a page not built yet).

import fs from "node:fs";
import path from "node:path";
import { isPackagePage } from "@cmd/protocol";
export { missingPage } from "@cmd/protocol";

/** Whether `src` names an .html file inside the package folder `dir` (a link out of it doesn't count). */
export function pageExists(dir: string, src: string): boolean {
  if (!isPackagePage(src)) return false;
  try {
    const root = fs.realpathSync(dir);
    const real = fs.realpathSync(path.join(root, src));
    return real.startsWith(root + path.sep) && fs.statSync(real).isFile();
  } catch {
    return false;
  }
}

/** Each `src="….html"` written as a string in the package's src/ (a Frame's page) that names no file of the package. */
export function missingPages(dir: string): { file: string; line: number; src: string }[] {
  const out: { file: string; line: number; src: string }[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx|ts|jsx|js)$/.test(e.name)) {
        const lines = fs.readFileSync(p, "utf8").split("\n");
        lines.forEach((text, i) => {
          for (const m of text.matchAll(/\bsrc=(?:"([^"\n]+\.html)"|'([^'\n]+\.html)'|\{["']([^"'\n]+\.html)["']\})/g)) {
            const src = m[1] ?? m[2] ?? m[3]!;
            if (!pageExists(dir, src)) out.push({ file: path.relative(dir, p), line: i + 1, src });
          }
        });
      }
    }
  };
  walk(path.join(dir, "src"));
  return out;
}
