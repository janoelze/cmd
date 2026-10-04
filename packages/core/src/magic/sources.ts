// Data sources of v1 Magic windows (an HTTP GET or a shell command in the
// window's state), still refreshed for windows made before widgets had their
// own data.ts (docs/14-magic-v2.md). preview() shortens data for the model.

import { classify, credentialsFor } from "./policy.ts";
import { execCommand, type SandboxMode } from "./sandbox.ts";

import type { MagicSource } from "@cmd/protocol";

export type { MagicSource };

export interface SourceResult {
  ok: boolean;
  /** Parsed JSON when the output is JSON, else the text. */
  data?: unknown;
  error?: string;
  ms: number;
  bytes: number;
}

export interface SourceContext {
  cwd: string;
  deny: string[];
  sandbox: SandboxMode;
  signal?: AbortSignal;
}

const MAX_BYTES = 1024 * 1024;

/** A stable key, so "was this exact source tested?" is a lookup. */
export function sourceKey(s: MagicSource): string {
  return s.type === "fetch" ? `fetch ${s.url} ${JSON.stringify(s.headers ?? {})}` : `command ${s.cwd ?? ""} ${s.command}`;
}

/** Validates a source from model output; returns an error message or the source. */
export function parseSource(v: unknown): MagicSource | string {
  if (!v || typeof v !== "object") return "source must be an object";
  const s = v as Record<string, unknown>;
  if (s.type === "fetch") {
    if (typeof s.url !== "string" || !/^https?:\/\//i.test(s.url)) return "a fetch source needs an http(s) url";
    const headers = s.headers && typeof s.headers === "object" ? (s.headers as Record<string, string>) : undefined;
    return headers ? { type: "fetch", url: s.url, headers } : { type: "fetch", url: s.url };
  }
  if (s.type === "command") {
    if (typeof s.command !== "string" || !s.command.trim()) return "a command source needs a command";
    return typeof s.cwd === "string" ? { type: "command", command: s.command, cwd: s.cwd } : { type: "command", command: s.command };
  }
  return 'source.type must be "fetch" or "command"';
}

function parse(text: string): unknown {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {}
  }
  return text;
}

export async function runSource(src: MagicSource, ctx: SourceContext): Promise<SourceResult> {
  const start = Date.now();
  if (src.type === "command") {
    const v = classify(src.command, { deny: ctx.deny, cwd: src.cwd ?? ctx.cwd });
    if (v.level !== "allow") return { ok: false, error: `not run: ${v.reason}`, ms: 0, bytes: 0 };
    const r = await execCommand(src.command, { cwd: src.cwd ?? ctx.cwd, maxBytes: MAX_BYTES, sandbox: ctx.sandbox, deny: ctx.deny, signal: ctx.signal, credentials: credentialsFor(src.command) });
    if (r.timedOut) return { ok: false, error: "timed out after 10 s", ms: r.ms, bytes: r.stdout.length };
    if (r.code !== 0) return { ok: false, error: `exited ${r.code ?? "abnormally"}: ${r.stderr.trim().slice(0, 500) || "(no output)"}`, ms: r.ms, bytes: r.stdout.length };
    return { ok: true, data: parse(r.stdout), ms: r.ms, bytes: r.stdout.length };
  }
  try {
    const res = await fetch(src.url, {
      headers: { "user-agent": "cmd-magic/0.1", accept: "application/json, text/plain, */*", ...src.headers },
      signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.subarray(0, MAX_BYTES).toString("utf8");
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}`, ms: Date.now() - start, bytes: buf.length };
    return { ok: true, data: parse(text), ms: Date.now() - start, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: (e as Error).message, ms: Date.now() - start, bytes: 0 };
  }
}

/** A compact preview of data for the model: valid JSON-ish text, long arrays and strings shortened. */
export function preview(data: unknown, maxChars = 6000): string {
  if (typeof data === "string") return data.length > maxChars ? data.slice(0, maxChars) + `\n… (${data.length - maxChars} more characters)` : data;
  const shrink = (v: unknown, depth: number): unknown => {
    if (Array.isArray(v)) {
      const head = v.slice(0, depth > 2 ? 3 : 8).map((x) => shrink(x, depth + 1));
      return v.length > head.length ? [...head, `… ${v.length - head.length} more items`] : head;
    }
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = shrink(x, depth + 1);
      return out;
    }
    if (typeof v === "string" && v.length > 200) return v.slice(0, 200) + "…";
    return v;
  };
  const s = JSON.stringify(shrink(data, 0), null, 1);
  return s.length > maxChars ? s.slice(0, maxChars) + "\n… (truncated)" : s;
}
