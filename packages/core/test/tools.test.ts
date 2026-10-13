// The tools (docs/54, One source): one registry, one access table. Every method a tool calls is
// open to tools in TOOL_ACCESS (a call to a `never` method would fail at run time, for every
// caller); names are unique; descriptions stay short, since every agent with cmd's MCP server
// carries them in its context.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Method } from "@cmd/protocol";
import { TOOL_ACCESS } from "../src/tools/access.ts";
import { TOOLS } from "../src/tools/index.ts";

const DIR = path.join(import.meta.dirname, "../src/tools");
/** Characters per tool description: the agent reads it on every session start that loads the tools. */
const DESCRIPTION_MAX = 700;

describe("the tools", () => {
  it("call only methods TOOL_ACCESS opens to them", () => {
    const called = new Set<string>();
    for (const f of fs.readdirSync(DIR).filter((f) => f.endsWith(".ts")))
      for (const m of fs.readFileSync(path.join(DIR, f), "utf8").matchAll(/\.call\("([\w.]+)"/g)) called.add(m[1]!);
    expect(called.size).toBeGreaterThan(20);
    const closed = [...called].filter((m) => !(m in TOOL_ACCESS) || TOOL_ACCESS[m as Method] === "never");
    expect(closed).toEqual([]);
    // What each tool says it calls (MCP's hints come from it) covers what its code calls.
    const declared = new Set(TOOLS.flatMap((t) => t.calls));
    expect([...called].filter((m) => !declared.has(m as Method))).toEqual([]);
    for (const t of TOOLS) expect(t.calls.filter((m) => TOOL_ACCESS[m] === "never"), t.spec.name).toEqual([]);
  });

  it("have unique names, an object schema with `why`, and short descriptions", () => {
    const names = TOOLS.map((t) => t.spec.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.spec.name).toMatch(/^[a-z]+$/);
      expect((t.spec.schema as { type: string }).type).toBe("object");
      expect((t.spec.schema as { required: string[] }).required).toContain("why");
      expect(t.spec.description.length, t.spec.name).toBeLessThanOrEqual(DESCRIPTION_MAX);
    }
  });
});
