// The stylesheets move things the way docs/37-motion.md says: durations and curves
// come from the tokens (so they're one set of values, and Reduce Motion reaches
// them), nothing animates layout but what's listed below with its reason, and
// nothing transitions a workspace window's geometry (TileMotion owns it).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const dirs = ["packages/ui/src", "apps/desktop/src/renderer"];
const files = dirs.flatMap((d) => (fs.readdirSync(path.join(root, d), { recursive: true }) as string[]).filter((f) => f.endsWith(".css")).map((f) => path.join(d, f)));

interface Decl { file: string; selector: string; prop: string; value: string; keyframes?: string }

/** Every declaration with the selector (or @keyframes name) it's in; Reduce Motion blocks left out. */
function declarations(file: string): Decl[] {
  const css = fs.readFileSync(path.join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Decl[] = [];
  const stack: string[] = [];
  let buf = "";
  for (const ch of css) {
    if (ch === "{") {
      stack.push(buf.trim());
      buf = "";
    } else if (ch === "}" || ch === ";") {
      const inReduce = stack.some((s) => s.includes("prefers-reduced-motion"));
      const m = buf.match(/^\s*([\w-]+)\s*:\s*([\s\S]+)$/);
      if (m && !inReduce && stack.length) {
        const kf = stack.find((s) => s.startsWith("@keyframes"));
        out.push({ file, selector: stack[stack.length - 1]!, prop: m[1]!, value: m[2]!.trim(), keyframes: kf?.replace("@keyframes", "").trim() });
      }
      buf = "";
      if (ch === "}") stack.pop();
    } else buf += ch;
  }
  return out;
}
const all = files.flatMap(declarations);
const motion = all.filter((d) => !d.keyframes && /^(transition|animation)(-duration)?$/.test(d.prop));

/** Literal durations that stay, and why. Matched on file and selector. */
const TIMED: { file: string; selector: RegExp; why: string }[] = [
  { file: "components.css", selector: /\.ui-dot\[data-enter/, why: "the status dot's pop and burst are choreographed indicators, with their own springy curves" },
  { file: "styles.css", selector: /\.prompt-flash/, why: "a highlight that fades over 0.7 s, long enough to be seen" },
  { file: "styles.css", selector: /\.tile\.bell/, why: "the visual bell: one flash of the outline" },
  { file: "styles.css", selector: /\.remote-badge\.typed/, why: "stays, then fades: a 4 s note" },
  { file: "magic.css", selector: /\.magic-hint-flash/, why: "a hint shown for 4.5 s" },
];
/** Layout properties that animate, and why. */
const LAYOUT: { file: string; selector: RegExp; why: string }[] = [
  { file: "styles.css", selector: /^\.slot\b/, why: "a title-bar slot eases its width as its value changes (Slot.tsx)" },
  { file: "styles.css", selector: /^\.dirty-dot\b/, why: "the unsaved dot makes room for itself" },
  { file: "styles.css", selector: /^\.term-progress > div/, why: "a progress bar's fill" },
  { file: "components.css", selector: /^\.ui-progress > span/, why: "a progress bar's fill" },
  { file: "components.css", selector: /\.ui-pagedots/, why: "the current page's dot widens to a pill" },
];
const LAYOUT_KEYFRAMES: Record<string, string> = {
  "ui-reveal-in": "data-motion=reveal opens a bar to its height",
  "ui-reveal-out": "data-motion=reveal closes a bar",
  "ui-progress": "the indeterminate progress bar sweeps",
};

const where = (d: Decl) => `${path.basename(d.file)} ${d.selector} { ${d.prop}: ${d.value} }`;
const listed = (list: { file: string; selector: RegExp }[], d: Decl) => list.some((x) => d.file.endsWith(x.file) && x.selector.test(d.selector));
const LAYOUT_PROPS = /\b(width|height|top|left|right|bottom|inset|margin(-\w+)?|padding(-\w+)?|flex-basis|grid-template-\w+|all)\b/;

describe("motion in the stylesheets", () => {
  it("found the stylesheets", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(motion.length).toBeGreaterThan(20);
  });

  it("takes durations from the tokens (--dur-fast, --dur, --dur-slow, --glide-dur)", () => {
    const literal = motion.filter((d) => /(^|[\s,(])\d*\.?\d+m?s\b/.test(d.value.replace(/var\([^)]*\)/g, "")) && !/\binfinite\b/.test(d.value) && !listed(TIMED, d));
    expect(literal.map(where)).toEqual([]);
  });

  it("transitions no layout property but the listed ones", () => {
    const layout = motion.filter((d) => d.prop.startsWith("transition") && LAYOUT_PROPS.test(d.value) && !listed(LAYOUT, d));
    expect(layout.map(where)).toEqual([]);
    const frames = all.filter((d) => d.keyframes && LAYOUT_PROPS.test(d.prop) && !(d.keyframes in LAYOUT_KEYFRAMES));
    expect(frames.map((d) => `@keyframes ${d.keyframes}: ${d.prop}`)).toEqual([]);
  });

  it("never transitions a workspace window's geometry (TileMotion owns it)", () => {
    const tile = motion.filter(
      (d) =>
        d.prop.startsWith("transition") &&
        d.selector.split(",").some((s) => /windows-track/.test(s) && /\.tile(\.[\w-]+|\[[^\]]+\]|:[\w-]+(\([^)]*\))?)*\s*$/.test(s.trim())) &&
        /\b(transform|width|height|opacity|all)\b/.test(d.value),
    );
    expect(tile.map(where)).toEqual([]);
  });
});
