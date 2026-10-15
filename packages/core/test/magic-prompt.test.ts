// Magic's prompt (magic/prompt/prompt.md) names the API's elements in prose: every element it
// names exists, with the props it names (`ListRowContent title place detail`, `Stack pad="inset"`),
// so renaming or dropping an element or a prop in the spec (protocol API_ELEMENTS) fails here.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_ELEMENTS, type ApiElementSpec } from "@cmd/protocol";
import { PROMPT_DIR } from "../src/magic/package/prompt.ts";
import { REPO } from "../src/magic/package/toolchain.ts";

const prose = fs.readFileSync(path.join(PROMPT_DIR, "prompt.md"), "utf8");
const spans = [...prose.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
const specOf = (name: string): ApiElementSpec | undefined => (Object.hasOwn(API_ELEMENTS, name) ? (API_ELEMENTS as Record<string, ApiElementSpec>)[name] : undefined);
/** An element as the prose uses it: `Name`, `<Name prop prop>`, `Name prop prop="value"`. */
const USE = /^<?([A-Z][A-Za-z]*)((?:\s+[a-z][A-Za-z]*(?:="[^"]*")?)*)>?$/;
/** What @cmd/widget-api and its testing entry declare or export by name (a type the prose names, like `GitStatus`). */
const declared = new Set<string>();
for (const dir of ["packages/widget-api/src", "packages/widget-api/src/testing"]) {
  for (const f of fs.readdirSync(path.join(REPO, dir)).filter((f) => f.endsWith(".ts"))) {
    const text = fs.readFileSync(path.join(REPO, dir, f), "utf8");
    for (const m of text.matchAll(/\b(?:export (?:type|interface|const|function|class)|as) ([A-Z]\w*)/g)) declared.add(m[1]!);
  }
}
/** Words in the prose that are neither: HTTP's and Deno's. */
const PLAIN = new Set(["Authorization", "Bearer", "Deno"]);

describe("Magic's prompt", () => {
  it("names only elements and props of the spec", () => {
    const wrong: string[] = [];
    for (const span of spans) {
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

  it("names elements at all (the check above sees them)", () => {
    const named = spans.map((s) => USE.exec(s)?.[1]).filter((n) => n && specOf(n));
    expect(new Set(named).size).toBeGreaterThan(20);
  });
});
