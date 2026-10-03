// The Magic agent's tools (docs/12-magic-windows.md → Agent). Defined once,
// independent of the model provider: the AI SDK backend wraps them in-process,
// CLI backends (claude -p, codex exec) reach them over MCP through a relay.
// All of them are read-only; `run` only runs what the policy calls read-only,
// under the sandbox. Every input carries `why`, a short label for the trace.

import fs from "node:fs";
import path from "node:path";
import { classify, credentialsFor, expandPath, isDeniedPath, redact } from "./policy.ts";
import { execCommand, type SandboxMode } from "./sandbox.ts";
import { parseSource, preview, runSource, sourceKey, type SourceResult } from "./sources.ts";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the input. */
  schema: Record<string, unknown>;
  /** Looks at the machine (off when exploring is off). */
  explores: boolean;
}

export interface ToolContext {
  cwd: string;
  home: string;
  deny: string[];
  sandbox: SandboxMode;
  signal?: AbortSignal;
  /** Sources tested in this run, by sourceKey. */
  tested: Map<string, SourceResult>;
}

export interface ToolOutput {
  output: string;
  isError: boolean;
}

const why = { type: "string", description: "A few words for the user saying what this step does, e.g. \"Looking at network services\"." };
const obj = (props: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties: { why, ...props },
  required: ["why", ...required],
  additionalProperties: false,
});

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "run",
    explores: true,
    description:
      "Run a read-only shell command on the user's Mac (no TTY, 10 s timeout, 64 KB output). Only read-only commands are allowed (ls, cat, grep, find, ps, df, du, scutil, networksetup, ifconfig, git status/log, curl GET, jq, sw_vers, system_profiler, pmset -g, defaults read, …); anything that writes, needs sudo or runs other programs is refused with the reason. Private paths (~/.ssh, keychains, browser profiles, .env files) can't be read.",
    schema: obj({ command: { type: "string" }, cwd: { type: "string", description: "Working folder; default: the user's current folder." } }, ["command"]),
  },
  {
    name: "read",
    explores: true,
    description: "Read a text file (up to 64 KB; optionally a line range).",
    schema: obj({ path: { type: "string" }, from: { type: "integer", minimum: 1 }, to: { type: "integer", minimum: 1 } }, ["path"]),
  },
  {
    name: "list",
    explores: true,
    description: "List a folder: names, kinds and sizes (folders first).",
    schema: obj({ path: { type: "string" } }, ["path"]),
  },
  {
    name: "fetch",
    explores: false,
    description: "HTTP GET a URL and return the status, content type and body (shortened). Use it to look at an API's response shape.",
    schema: obj({ url: { type: "string" } }, ["url"]),
  },
  {
    name: "test_source",
    explores: false,
    description:
      "Run a widget data source exactly as cmd will on every refresh, and return a preview of its data (or the error). Call it with the exact source you will put in your answer's header before writing the view.",
    schema: obj(
      {
        source: {
          type: "object",
          description: '{"type":"fetch","url":"https://…"} or {"type":"command","command":"…"} (a read-only command; JSON output is parsed).',
          properties: { type: { type: "string", enum: ["fetch", "command"] }, url: { type: "string" }, command: { type: "string" }, cwd: { type: "string" } },
          required: ["type"],
        },
      },
      ["source"],
    ),
  },
];

/** The tools for a run: without the exploring ones when exploring is off. */
export function toolsFor(explore: boolean): ToolSpec[] {
  return TOOL_SPECS.filter((t) => explore || !t.explores);
}

const err = (output: string): ToolOutput => ({ output, isError: true });
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const MAX = 64 * 1024;

function resolvePath(p: string, ctx: ToolContext): string {
  return path.resolve(ctx.cwd, expandPath(p, ctx.home));
}

export async function runTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
  switch (name) {
    case "run": {
      const command = str(input.command);
      if (!command) return err("command is required");
      const cwd = str(input.cwd) ? resolvePath(str(input.cwd)!, ctx) : ctx.cwd;
      const v = classify(command, { deny: ctx.deny, home: ctx.home, cwd });
      if (v.level !== "allow") return err(`Not run: ${v.reason}. Use a read-only command instead.`);
      const r = await execCommand(command, { cwd, sandbox: ctx.sandbox, deny: ctx.deny, signal: ctx.signal, credentials: credentialsFor(command) });
      if (r.code === null && !r.timedOut) return err(r.stderr || "could not run");
      const parts = [`exit ${r.timedOut ? "(timed out after 10 s)" : r.code}`];
      if (r.stdout) parts.push(r.stdout + (r.truncated ? "\n… (output truncated)" : ""));
      if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.trim().slice(0, 4000)}`);
      return { output: redact(parts.join("\n")), isError: r.code !== 0 };
    }
    case "read": {
      const p = str(input.path);
      if (!p) return err("path is required");
      const abs = resolvePath(p, ctx);
      if (isDeniedPath(abs, ctx.deny, ctx.home, ctx.cwd)) return err(`${p} is private; it can't be read.`);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        return err(`no such file: ${p}`);
      }
      if (st.isDirectory()) return err(`${p} is a folder; use list.`);
      const buf = Buffer.alloc(Math.min(st.size, MAX));
      const fd = fs.openSync(abs, "r");
      try {
        fs.readSync(fd, buf, 0, buf.length, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (buf.subarray(0, 8192).includes(0)) return err(`${p} is a binary file (${st.size} bytes).`);
      let text = buf.toString("utf8");
      const from = typeof input.from === "number" ? input.from : undefined;
      const to = typeof input.to === "number" ? input.to : undefined;
      if (from || to) text = text.split("\n").slice((from ?? 1) - 1, to).join("\n");
      return { output: redact(text) + (st.size > MAX && !from && !to ? `\n… (file is ${st.size} bytes; shown: first 64 KB)` : ""), isError: false };
    }
    case "list": {
      const p = str(input.path) ?? ".";
      const abs = resolvePath(p, ctx);
      if (isDeniedPath(abs, ctx.deny, ctx.home, ctx.cwd)) return err(`${p} is private; it can't be listed.`);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch (e) {
        return err((e as Error).message);
      }
      const rows = entries
        .map((d) => {
          let size = "";
          try {
            if (d.isFile()) size = String(fs.statSync(path.join(abs, d.name)).size);
          } catch {}
          return { name: d.name, dir: d.isDirectory(), line: `${d.isDirectory() ? "d" : d.isSymbolicLink() ? "l" : "f"}  ${d.name}${d.isDirectory() ? "/" : ""}${size ? `  ${size}` : ""}` };
        })
        .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
      const shown = rows.slice(0, 300).map((r) => r.line);
      if (rows.length > 300) shown.push(`… ${rows.length - 300} more`);
      return { output: `${abs}\n${shown.join("\n")}`, isError: false };
    }
    case "fetch": {
      const url = str(input.url);
      if (!url || !/^https?:\/\//i.test(url)) return err("an http(s) url is required");
      try {
        const res = await fetch(url, { headers: { "user-agent": "cmd-magic/0.1" }, signal: AbortSignal.timeout(10_000), redirect: "follow" });
        // A stream (a web radio) never ends: its headers are the answer.
        const type = res.headers.get("content-type") ?? "";
        if (/^(audio|video)\/|ogg|aacp|mpegurl/i.test(type)) {
          void res.body?.cancel();
          return { output: `HTTP ${res.status} ${type}\n(a media stream at ${res.url}; not read)`, isError: !res.ok };
        }
        const text = (await res.text()).slice(0, MAX);
        let body = text;
        try {
          body = preview(JSON.parse(text));
        } catch {}
        return { output: redact(`HTTP ${res.status} ${res.headers.get("content-type") ?? ""}\n${body.slice(0, 12_000)}`), isError: !res.ok };
      } catch (e) {
        return err((e as Error).message);
      }
    }
    case "test_source": {
      const s = parseSource(input.source);
      if (typeof s === "string") return err(s);
      const r = await runSource(s, { cwd: ctx.cwd, deny: ctx.deny, sandbox: ctx.sandbox, signal: ctx.signal });
      if (r.ok) ctx.tested.set(sourceKey(s), r);
      if (!r.ok) return err(redact(`The source failed: ${r.error}`));
      const kind = typeof r.data === "string" ? "text" : "JSON";
      return { output: `OK in ${r.ms} ms, ${r.bytes} bytes of ${kind}. Your view's cmd.onData(fn) gets ${kind === "JSON" ? "this parsed value" : "this string"}:\n${redact(preview(r.data))}`, isError: false };
    }
  }
  return err(`unknown tool: ${name}`);
}
