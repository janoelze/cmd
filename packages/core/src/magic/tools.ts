// The Magic agent's tools for looking around (docs/12-magic-widgets.md → Agent):
// all read-only; `run` only runs what the policy calls read-only, under the
// sandbox. The tools that build the widget are in widget-tools.ts. Every input
// carries `why`, a short label for the trace.

import fs from "node:fs";
import path from "node:path";
import { classify, credentialsFor, expandPath, redact } from "./policy.ts";
import { privateMatcher } from "../paths-deny.ts";
import { execCommand, type SandboxMode } from "./sandbox.ts";
import { preview } from "./sources.ts";
import { FetchRefused, guardedFetch, type Lookup } from "./fetch.ts";

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
  /** Tests: how fetch resolves host names, and which it takes as public. */
  fetch?: { lookup?: Lookup; publicHosts?: string[] };
}

export interface ToolOutput {
  output: string;
  isError: boolean;
  /** Screenshots (base64 PNG) for the model to look at. */
  images?: string[];
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
      "Run a read-only shell command on the user's Mac (no TTY, 10 s timeout, 64 KB output). Only read-only commands are allowed (ls, cat, grep, find, ps, df, du, scutil, networksetup, ifconfig, git status/log, jq, sw_vers, system_profiler, pmset -g, defaults read, …); anything that writes, needs sudo or runs other programs is refused with the reason. Private paths (~/.ssh, keychains, browser profiles, .env files, cmd's own secrets and settings) can't be read.",
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
    description: "HTTP GET a public URL and return the status, content type and body (shortened). Use it to look at an API's response shape. Local and private addresses (localhost, 10.x, 192.168.x, 169.254.x, …) are refused.",
    schema: obj({ url: { type: "string" } }, ["url"]),
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
      if (privateMatcher(ctx.deny, ctx.home, ctx.cwd)(abs)) return err(`${p} is private; it can't be read.`);
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
      const isPrivate = privateMatcher(ctx.deny, ctx.home, ctx.cwd);
      if (isPrivate(abs)) return err(`${p} is private; it can't be listed.`);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch (e) {
        return err((e as Error).message);
      }
      // Private entries are named (so the model knows ~/.ssh exists) but marked, without a size.
      const rows = entries
        .map((d) => {
          const hidden = isPrivate(path.join(abs, d.name));
          let size = "";
          try {
            if (d.isFile() && !hidden) size = String(fs.statSync(path.join(abs, d.name)).size);
          } catch {}
          return { name: d.name, dir: d.isDirectory(), line: `${d.isDirectory() ? "d" : d.isSymbolicLink() ? "l" : "f"}  ${d.name}${d.isDirectory() ? "/" : ""}${size ? `  ${size}` : ""}${hidden ? " (private)" : ""}` };
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
        // A stream (a web radio) never ends: its headers are the answer.
        const res = await guardedFetch(url, { headers: { "user-agent": "cmd-magic/0.1" }, ...ctx.fetch, signal: ctx.signal, maxBytes: MAX, stream: /^(audio|video)\/|ogg|aacp|mpegurl/i });
        const ok = res.status >= 200 && res.status < 300;
        if (res.streamed) return { output: `HTTP ${res.status} ${res.contentType}\n(a media stream at ${res.url}; not read)`, isError: !ok };
        let body = res.body;
        try {
          body = preview(JSON.parse(res.body));
        } catch {}
        return { output: redact(`HTTP ${res.status} ${res.contentType}\n${body.slice(0, 12_000)}`), isError: !ok };
      } catch (e) {
        return err(e instanceof FetchRefused ? e.message : `Not fetched: ${(e as Error).message}`);
      }
    }
  }
  return err(`unknown tool: ${name}`);
}
