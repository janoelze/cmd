// The registries' two ends agree (docs/architecture-review-01/13 AR1-13-02): every API
// method in protocol's Methods has a caller (the CLI, the app, the web client or the core
// itself; tsc and handlers.test.ts check it has a handler), and every window type the core
// registers has a view in the renderer, and every tool an agent may call is reachable from MCP
// (`cmd mcp`) and the CLI (`cmd tool`). Read from the sources, so it costs no build.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../packages/core/src/tools/index.ts";
import { AGENT_TOOLS } from "../packages/core/src/tools/runner.ts";

const root = path.join(import.meta.dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
function files(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) files(rel, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.(test|story)\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** Methods by name: each `"x.y": { params` in protocol's sources (Methods and the features' own method maps). The widget API's verbs (widget-tree.ts) are no RPC methods: the widget host's adapter serves them. */
const methods = files("packages/protocol/src").filter((f) => !f.endsWith("widget-tree.ts")).flatMap((f) => [...read(f).matchAll(/^\s+"([a-z][A-Za-z]*\.[A-Za-z.]+)":\s*\{\s*params/gm)].map((m) => m[1]!));

/** Where calls come from: the clients, and the core calling itself (not where methods are declared, handled or listed for remote or Operator access). */
const callers = [...files("packages/cli/src"), ...files("apps/desktop/src"), ...files("apps/web/src"), ...files("packages/core/src").filter((f) => !/\/handlers\.ts$|\/feature\.ts$|remote\/policy\.ts$|tools\/access\.ts$|kernel\/core\.ts$/.test(f))];

/** The window kinds the core registers (windows/builtin.ts, a feature's scopedWidget) and the views the renderer registers. */
const coreKinds = new Set(files("packages/core/src").flatMap((f) => [...read(f).matchAll(/^\s+kind: "([a-z-]+)",$/gm), ...read(f).matchAll(/scopedWidget\("([a-z-]+)"/g)].filter(() => /windows\/builtin\.ts$|\/feature\.ts$/.test(f)).map((m) => m[1]!)));
const views = new Set(files("apps/desktop/src/renderer/src/windows").filter((f) => f.endsWith("register.tsx")).flatMap((f) => [...read(f).matchAll(/registerWindowView\(\{\s*kind: "([a-z-]+)"/g)].map((m) => m[1]!)));
/** Drawn by the board itself, not through a registered view. */
const BOARD = ["terminal"];
/** Views that serve kinds the core registers at run time: "package" every "pkg:<package>/<widget>" (widgets/packages.ts, docs/56). */
if (/types\.register\(/.test(read("packages/core/src/widgets/packages.ts"))) coreKinds.add("package");

describe("registries", () => {
  it("found what to compare", () => {
    expect(methods.length).toBeGreaterThan(100);
    expect([...coreKinds]).toEqual(expect.arrayContaining(["browser", "files", "journal", "commands"]));
    expect([...views]).toEqual(expect.arrayContaining(["browser", "files", "journal"]));
  });

  it("every method has a caller", () => {
    const text = callers.map(read).join("\n");
    const unused = methods.filter((m) => !text.includes(`"${m}"`) && !text.includes(`'${m}'`) && !text.includes(`\`${m}\``));
    expect(unused, `Methods no client or core code calls (remove them, or call them):\n${unused.join("\n")}`).toEqual([]);
  });

  it("every window type the core registers has a view in the renderer", () => {
    const missing = [...coreKinds].filter((k) => !views.has(k) && !BOARD.includes(k));
    expect(missing, `Window types without a renderer view (windows/<kind>/register.tsx):\n${missing.join("\n")}`).toEqual([]);
    const orphans = [...views].filter((k) => !coreKinds.has(k));
    expect(orphans, `Renderer views for window types the core doesn't register:\n${orphans.join("\n")}`).toEqual([]);
  });

  it("every tool is reachable from MCP and the CLI, and defined only in the core's registry", () => {
    // Both surfaces list and call through the registry's methods, never a list of their own.
    const cli = read("packages/cli/src/tools.ts");
    for (const m of ["tools.list", "tools.call"]) expect(cli.split(`"${m}"`).length - 1, m).toBeGreaterThanOrEqual(2);
    expect(cli).not.toMatch(/name: "(look|read|open|agent)"/);
    // Every tool but those for models without tools of their own (edit) reaches agents.
    expect(TOOLS.filter((t) => !AGENT_TOOLS.includes(t)).map((t) => t.spec.name)).toEqual(["edit"]);
    // No tool is defined outside packages/core/src/tools.
    const defined = files("packages").filter((f) => /: Tool = \{/.test(read(f)));
    expect(defined.every((f) => f.startsWith("packages/core/src/tools/"))).toBe(true);
  });
});
