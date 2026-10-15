// The prose agents read about the widget API: Magic's prompt (magic/prompt/prompt.md) and the
// CLAUDE.md `cmd widget new` writes (cli templates/widget/CLAUDE.md). Their lists (the live
// hooks, the toolbar's items, the permission keys with their values) are generated from the
// API's rows (scripts/widget-api-blocks.ts) and must be current; everything else the prose
// names must exist: each element with the props it names (`ListRowContent title place
// detail`), each `cmd.…` verb, hook, `fmt` function, matcher, fixture, finder and hand of the
// testing tree, each permission it shows as package.json writes it (a frame page's `cmd` against
// the reference's Frames section and the process's verbs); and the prompt teaches
// every act verb. Renaming or dropping any of them fails here, as a stale block does.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_ACT_NAMESPACES, API_ACT_VERBS, API_AI_USES, API_ELEMENTS, PERMISSION_KEYS, type ApiElementSpec } from "@cmd/protocol";
import { PROMPT_DIR, apiReference, buildPackageSystem, withoutMarkers } from "../src/magic/package/prompt.ts";
import { REPO } from "../src/magic/package/toolchain.ts";
import { declarable } from "../src/data/policy.ts";
import { BLOCK_FILES, blocks, withBlocks } from "../../../scripts/widget-api-blocks.ts";

const PROMPT = path.join(PROMPT_DIR, "prompt.md");
const TEMPLATE = path.join(REPO, "packages/cli/templates/widget/CLAUDE.md");
const read = (f: string) => fs.readFileSync(f, "utf8");
const spansOf = (text: string) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
const specOf = (name: string): ApiElementSpec | undefined => (Object.hasOwn(API_ELEMENTS, name) ? (API_ELEMENTS as Record<string, ApiElementSpec>)[name] : undefined);
/** An element as the prose uses it: `Name`, `<Name prop prop>`, `Name prop prop="value"`. */
const USE = /^<?([A-Z][A-Za-z]*)((?:\s+[a-z][A-Za-z]*(?:="[^"]*")?)*)>?$/;
const src = (rel: string) => read(path.join(REPO, rel));
/** What @cmd/widget-api and its testing entry declare or export by name (a type the prose names, like `GitStatus`). */
const declared = new Set<string>();
for (const dir of ["packages/widget-api/src", "packages/widget-api/src/testing"]) {
  for (const f of fs.readdirSync(path.join(REPO, dir)).filter((f) => f.endsWith(".ts"))) {
    for (const m of src(`${dir}/${f}`).matchAll(/\b(?:export (?:type|interface|const|function|class)|as) ([A-Z]\w*)/g)) declared.add(m[1]!);
  }
}
/** Words in the prose that are neither: HTTP's and Deno's. */
const PLAIN = new Set(["Authorization", "Bearer", "Deno"]);
/** The API reference (the README's): every verb as `cmd.ns.verb(`, every hook as `useX(`. */
const ref = apiReference();
/** The testing tree's methods (finders and hands), matchers and fixtures, from their sources. */
const tree = src("packages/widget-api/src/testing/tree.ts");
const methods = new Set([...tree.slice(tree.indexOf("export class RenderedTree")).matchAll(/^ {2}(?:async )?(\w+)\(/gm)].map((m) => m[1]!));
const matcherNames = new Set([...tree.slice(tree.indexOf("export const matchers")).matchAll(/^ {2}(to[A-Z]\w*)\(/gm)].map((m) => m[1]!));
const fixtureNames = new Set(/export const fixtures = \{([^}]*)\}/.exec(src("packages/widget-api/src/testing/fixtures.ts"))![1]!.split(",").map((s) => s.trim()));
const host = src("packages/widget-api/src/testing/host.ts");
/** The reference's section on a frame page's `cmd` (@cmd/widget-api/frame): its own members; its verbs are the process's. */
const frameRef = ref.slice(ref.indexOf("### Frames"), ref.indexOf("### Elements"));
/** React's own hooks, which the prose may name beside the API's. */
const REACT = new Set(["useState", "useEffect", "useMemo", "useCallback", "useRef"]);
/** package.json's `cmd` block, which the prose names as `cmd.widgets[]`, `cmd.permissions`. */
const MANIFEST = new Set(["api", "widgets", "permissions"]);

/** What a file's prose names that doesn't exist, one line each. */
function wrongNames(file: string): string[] {
  const wrong: string[] = [];
  for (const line of withoutMarkers(read(file)).split("\n")) {
    // The frame's `cmd` (view.html's, frame.js): the process's verbs without the hooks, and its own members.
    const inFrame = line.includes('"surface": "frame"');
    const spans = spansOf(line);
    for (const span of spans) {
      for (const m of span.matchAll(/\bcmd\.([a-z]+(?:\.[a-zA-Z]+)*)/g)) {
        const p = m[1]!;
        if (inFrame) {
          const own = frameRef.includes(`cmd.${p}(`) || frameRef.includes(`cmd.${p}: `);
          const verb = !/(^|\.)use$/.test(p) && !p.startsWith("fmt") && ref.includes(`cmd.${p}(`);
          if (!own && !verb) wrong.push(`\`${span}\`: the frame's cmd has no ${p}`);
        } else if (!MANIFEST.has(p.split(".")[0]!) && !ref.includes(`cmd.${p}(`) && !ref.includes(`cmd.${p}<`) && !ref.includes(`#### \`cmd.${p}\``) && !ref.includes(`| \`cmd.${p}\` |`)) wrong.push(`\`${span}\`: no cmd.${p} in the reference`);
      }
      for (const m of span.matchAll(/\b(use[A-Z]\w*)/g)) if (!REACT.has(m[1]!) && !ref.includes(`\`${m[1]}(`) && !ref.includes(`\`${m[1]}<`)) wrong.push(`\`${span}\`: no hook ${m[1]}`);
      for (const m of span.matchAll(/(?<![.\w])fmt\.(\w+)/g)) if (!ref.includes(`cmd.fmt.${m[1]}(`)) wrong.push(`\`${span}\`: no fmt.${m[1]}`);
      for (const m of span.matchAll(/\b(to[A-Z]\w*)/g)) if (!matcherNames.has(m[1]!)) wrong.push(`\`${span}\`: no matcher ${m[1]}`);
      for (const m of span.matchAll(/\bfixtures\.(\w+)/g)) if (!fixtureNames.has(m[1]!)) wrong.push(`\`${span}\`: no fixtures.${m[1]}`);
      for (const m of span.matchAll(/\bhost\.(\w+)/g)) if (!new RegExp(`\\b${m[1]}\\b`).test(host)) wrong.push(`\`${span}\`: the fake host has no ${m[1]}`);
      wrong.push(...wrongPermission(span));
    }
    // The line that lists the tree's finders and hands: each call in it is a method of the tree (or render, createHost).
    if (spans.includes("press(node)"))
      for (const span of spans) {
        const m = /^([a-z]\w*)\(.*\)$/.exec(span);
        if (m && !methods.has(m[1]!) && !["render", "createHost"].includes(m[1]!) && !fixtureNames.has(m[1]!)) wrong.push(`\`${span}\`: the rendered tree has no ${m[1]}`);
      }
  }
  return wrong;
}

/** A permission as package.json writes it (`workspace: ["read"]`): a key cmd knows, with values it takes. */
function wrongPermission(span: string): string[] {
  const m = /^(\w+): (\[.*\])$/.exec(span);
  if (!m || !(PERMISSION_KEYS as readonly string[]).includes(m[1]!)) return m && /^[a-z]+$/.test(m[1]!) && !["size"].includes(m[1]!) ? [`\`${span}\`: no permission ${m[1]}`] : [];
  let values: string[];
  try {
    values = JSON.parse(m[2]!) as string[];
  } catch {
    return []; // a placeholder: `net: [<host>]`
  }
  const may: Partial<Record<string, readonly string[]>> = { workspace: ["read", "all"], events: declarable("widget"), ai: API_AI_USES, act: [...API_ACT_NAMESPACES, ...API_ACT_VERBS] };
  const ok = may[m[1]!];
  return ok ? values.filter((v) => !ok.includes(v)).map((v) => `\`${span}\`: ${m[1]} can't be "${v}"`) : [];
}

describe.each([
  ["Magic's prompt", PROMPT],
  ["the widget template's CLAUDE.md", TEMPLATE],
])("%s", (_, file) => {
  const text = read(file);

  it("has its generated lists current (pnpm widget-api:docs)", () => {
    expect(BLOCK_FILES).toContain(file);
    expect(withBlocks(text) === text, `${path.relative(REPO, file)} is stale: run pnpm widget-api:docs`).toBe(true);
    expect([...text.matchAll(/<!-- gen:([\w-]+) -->/g)].length).toBeGreaterThanOrEqual(2);
  });

  it("names only elements and props of the spec", () => {
    const wrong: string[] = [];
    for (const span of spansOf(withoutMarkers(text))) {
      const m = USE.exec(span);
      if (!m) continue;
      const [, name, rest] = m as unknown as [string, string, string];
      const spec = specOf(name);
      const props = rest.trim() ? rest.trim().split(/\s+/) : [];
      // A bare word: an element, or a name the API declares.
      if (!props.length && !span.startsWith("<")) {
        if (!spec && !declared.has(name) && !PLAIN.has(name)) wrong.push(`\`${span}\`: no element or export ${name}`);
        continue;
      }
      if (!spec) {
        wrong.push(`\`${span}\`: no element ${name}`);
        continue;
      }
      for (const p of props) {
        const [key, value] = p.split("=") as [string, string | undefined];
        const prop = spec.props[key];
        if (!prop && !Object.hasOwn(spec.events, key)) wrong.push(`\`${span}\`: ${name} has no ${key}`);
        else if (prop && value !== undefined && Array.isArray(prop.type) && !prop.type.includes(JSON.parse(value))) wrong.push(`\`${span}\`: ${name}'s ${key} can't be ${value}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("names only verbs, hooks, fmt, the testing tree's names and permissions that exist", () => {
    expect(wrongNames(file)).toEqual([]);
  });
});

describe("Magic's prompt", () => {
  const prose = read(PROMPT);

  it("names elements at all (the check above sees them)", () => {
    const named = spansOf(prose).map((s) => USE.exec(s)?.[1]).filter((n) => n && specOf(n));
    expect(new Set(named).size).toBeGreaterThan(20);
  });

  it("teaches every act verb (a new one is described before Magic is told of it)", () => {
    expect(API_ACT_VERBS.filter((v) => !prose.includes(`cmd.${v}(`))).toEqual([]);
  });

  it("reaches the model without the blocks' markers", () => {
    const system = buildPackageSystem();
    expect(system).not.toContain("<!--");
    const all = blocks();
    for (const [, name] of prose.matchAll(/<!-- gen:([\w-]+) -->/g)) expect(system).toContain(all[name!]!.split("\n")[0]!.trim());
  });

  it("the checks see a wrong name (the regexes match the prose)", () => {
    const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "magic-prompt-")), "p.md");
    fs.writeFileSync(tmp, "`cmd.agents.launch(x)`, `useAgentz()`, `fmt.agoo(t)`, `toHaveRows`, `fixtures.agents()`, `host.callz`, `events: [\"secrets\"]`, `act: [\"files\"]`\n`press(node)`, `poke(node)`\nA `\"surface\": \"frame\"` page: `cmd.agents.list()`, `cmd.on(t, fn)`, `cmd.theme`, `cmd.agents.use()`, `cmd.frobnicate(x)`");
    expect(wrongNames(tmp).map((w) => w.split(":")[0])).toEqual(["`cmd.agents.launch(x)`", "`useAgentz()`", "`fmt.agoo(t)`", "`toHaveRows`", "`fixtures.agents()`", "`host.callz`", '`events', '`act', "`poke(node)`", "`cmd.agents.use()`", "`cmd.frobnicate(x)`"]);
  });
});
