// Guards for the e2e scripts themselves: the patterns that made the smoke test slow or
// let it pass on a wait that could never end (docs/41-testing.md, "Speed hacks"). Each
// rule names what it costs. A fixed wait budget per file locks in the count, like
// design-debt.json for stylesheets: adding one fails, removing one fails until lowered here.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const e2e = path.join(root, "e2e");
const scripts = fs
  .readdirSync(e2e)
  .filter((f) => f.endsWith(".mjs"))
  .map((f) => ({ name: f, lines: fs.readFileSync(path.join(e2e, f), "utf8").split("\n") }));
const smoke = scripts.find((s) => s.name === "smoke.mjs")!;
const linesWith = (lines: string[], re: RegExp) => lines.flatMap((l, i) => (re.test(l) ? [{ line: i + 1, text: l.trim() }] : []));

/** Fixed waits (waitForTimeout) per script: what each run sits out whatever the app does. */
const FIXED_WAITS: Record<string, number> = {
  "a11y-audit.mjs": 3,
  "drops.mjs": 8,
  "smoke.mjs": 13,
  "startup-profile.mjs": 1,
  "startup.mjs": 2,
  "web.mjs": 1,
};

describe("e2e scripts", () => {
  it("keep their fixed waits within budget", () => {
    const counts = Object.fromEntries(scripts.map((s) => [s.name, linesWith(s.lines, /\.waitForTimeout\(/).length]).filter(([, n]) => n));
    // Wait for what the next step reads (until(), a locator, still()); a fixed wait is only for
    // an input to land or a wrong outcome to show. Fewer than budgeted: lower the number here.
    expect(counts).toEqual(FIXED_WAITS);
  });

  it("say why each fixed wait in the smoke test is there", () => {
    // On its line or the one before: "(not a read)", "give a wrong close time to show", a poll's interval.
    const bare = linesWith(smoke.lines, /\.waitForTimeout\(/).filter(({ line }) => !/\/\//.test(smoke.lines[line - 1]!) && !/^\s*\/\//.test(smoke.lines[line - 2] ?? ""));
    expect(bare).toEqual([]);
  });

  it("never swallow a wait that ran out", () => {
    // `.waitFor(...).catch(() => {})` turns a 10 s deadline into a silent pass; the smoke test's
    // expired() says "[waited out]" instead, and a run with one fails.
    const swallowed = scripts.flatMap((s) => linesWith(s.lines, /\.waitFor(Selector|Function)?\(.*\)\.catch\(\(\) => \{\}\)/).map((x) => ({ script: s.name, ...x })));
    expect(swallowed).toEqual([]);
  });

  it("take screenshots in the smoke test only through shot() or on a failure", () => {
    // Each one costs about 200 ms: 7 s of a run, for pictures nobody looked at (E2E_SHOTS=1 takes them).
    const direct = linesWith(smoke.lines, /\.screenshot\(/).filter(({ text }) => !/const shot = |failed|hung/.test(text));
    expect(direct).toEqual([]);
  });

  it("launch the app in background mode", () => {
    // CMD_BACKGROUND: no focus stealing, and an app whose script was killed quits instead of
    // joining the next run's core as a second window (main/background.ts).
    const without = scripts.filter((s) => s.lines.some((l) => /electron\.launch\(/.test(l)) && !s.lines.some((l) => /CMD_BACKGROUND/.test(l))).map((s) => s.name);
    expect(without).toEqual([]);
  });

  it("read only UI state keys the app still writes", () => {
    // A renamed key (sidebar.collapsed → sidebar.sections) left a wait for it running out its
    // 10 s on every run while the check after it passed another way.
    const app = ["apps/desktop/src", "packages/core/src", "packages/protocol/src"].flatMap((d) => walk(path.join(root, d))).map((f) => fs.readFileSync(f, "utf8")).join("\n");
    const text = smoke.lines.join("\n");
    const keys = new Set([
      ...[...text.matchAll(/homeView\(\)\)\["([\w.]+)"\]/g)].map((m) => m[1]!),
      ...[...text.matchAll(/homeView\(\)\)\.(\w+)/g)].map((m) => m[1]!),
      ...[...text.matchAll(/\bui?\["([\w.]+)"\]/g)].map((m) => m[1]!),
    ]);
    expect(keys.size).toBeGreaterThan(3); // the patterns still find the reads
    expect([...keys].filter((k) => !app.includes(`"${k}"`))).toEqual([]);
  });

  it("build only when the sources changed", () => {
    // `pnpm build &&` rebuilt the app on every run; scripts/build-if-stale.mjs skips it when the build is current.
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    const rebuilding = Object.entries(pkg.scripts).filter(([name, cmd]) => name.startsWith("e2e") && /pnpm build/.test(cmd));
    expect(rebuilding).toEqual([]);
  });
});

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}
