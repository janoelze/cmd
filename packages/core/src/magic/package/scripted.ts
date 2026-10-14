// A model that plays a script (tests, and the e2e's Magic scenario through CMD_MAGIC_SCRIPT):
// each run of the agent loop makes the next turn's tool calls through the build's own exec,
// then answers its sentence. `forever` keeps calling a tool until it is stopped, reporting
// usage as it goes: the build's token ceiling is what ends it.

import fs from "node:fs";
import type { Backend, BackendRun, Usage } from "../../ai/backends.ts";
import type { ToolOutput } from "../tools.ts";

export interface ScriptTurn {
  calls?: { name: string; input: Record<string, unknown> }[];
  answer?: string;
}

export interface Script {
  turns?: ScriptTurn[];
  /** Call read_file on package.json again and again (with `usage` tokens a step) until stopped. */
  forever?: boolean;
  /** Tokens each step reports (default 1000). */
  usage?: number;
}

export type ScriptedBackend = Backend & { seen: BackendRun[]; outputs: { name: string; output: ToolOutput }[] };

const usageOf = (n: number): Usage => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0 });

export function scriptedBackend(script: Script): ScriptedBackend {
  const turns = [...(script.turns ?? [])];
  const step = script.usage ?? 1000;
  const seen: BackendRun[] = [];
  const outputs: { name: string; output: ToolOutput }[] = [];
  return {
    name: "script",
    model: "script",
    seen,
    outputs,
    async run(r) {
      seen.push({ ...r, messages: r.messages.map((m) => ({ ...m })) });
      let used = 0;
      const call = async (name: string, input: Record<string, unknown>) => {
        if (r.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        r.onTurn();
        const output = await r.exec(name, input);
        outputs.push({ name, output });
        used += step;
        r.onUsage?.(usageOf(step));
      };
      if (script.forever) for (;;) await call("read_file", { why: "Reading it again", path: "package.json" });
      const t = turns.shift() ?? { answer: "(done)" };
      for (const c of t.calls ?? []) await call(c.name, c.input);
      return { text: t.answer ?? "", model: "script", usage: usageOf(used) };
    },
  };
}

/** The script in $CMD_MAGIC_SCRIPT (a JSON file), if that is set: for the e2e. */
export function scriptFromEnv(): Script | null {
  const file = process.env.CMD_MAGIC_SCRIPT;
  if (!file) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as Script;
}
