// Runs a widget's data.ts once (deno run … runner.ts <widget dir>), with its
// config on stdin, and prints one result line for cmd:
//   {"ok":true,"data":…,"ms":12}
//   {"ok":false,"error":"…","issues":[…],"retryAfter":60}
// The data function's own console output goes to stderr, so it can't corrupt
// the result. The data is validated against the exported `schema`.

import { HttpError, Schema, SchemaError } from "./cmd.ts";

const MARK = "\u0000cmd-result ";
const out = (r: Record<string, unknown>) => Deno.stdout.writeSync(new TextEncoder().encode(MARK + JSON.stringify(r) + "\n"));

// Only cmd writes stdout.
for (const k of ["log", "info", "debug", "table", "dir"] as const) (console as unknown as Record<string, unknown>)[k] = console.error;

const dir = Deno.args[0];
if (!dir) {
  out({ ok: false, error: "runner: no widget folder" });
  Deno.exit(2);
}

let config: Record<string, unknown> = {};
try {
  const text = new TextDecoder().decode(await new Response(Deno.stdin.readable).arrayBuffer());
  if (text.trim()) config = JSON.parse(text);
} catch (e) {
  out({ ok: false, error: `runner: bad config: ${(e as Error).message}` });
  Deno.exit(2);
}

const start = performance.now();
try {
  const mod = (await import(new URL("data.ts", `file://${dir.endsWith("/") ? dir : dir + "/"}`).href)) as { default?: unknown; schema?: unknown };
  if (typeof mod.default !== "function") throw new Error("data.ts must export a default async function returning the data");
  if (!(mod.schema instanceof Schema)) throw new Error('data.ts must export `schema` (built with s from "cmd")');
  const data = await (mod.default as (c: unknown) => unknown)(config);
  const issues = mod.schema.issues(data);
  if (issues.length) {
    out({ ok: false, error: new SchemaError(issues).message, issues: issues.slice(0, 20), data, ms: Math.round(performance.now() - start) });
    Deno.exit(1);
  }
  out({ ok: true, data, ms: Math.round(performance.now() - start) });
  Deno.exit(0);
} catch (e) {
  const err = e as Error;
  const r: Record<string, unknown> = { ok: false, error: err?.message ?? String(e), ms: Math.round(performance.now() - start) };
  if (e instanceof HttpError) Object.assign(r, { status: e.status, retryAfter: e.retryAfter });
  if (e instanceof Deno.errors.NotCapable || /Requires (net|run|read|env) access/.test(err?.message ?? "")) r.permission = true;
  if (err?.stack) r.stack = err.stack.split("\n").slice(0, 8).join("\n");
  out(r);
  Deno.exit(1);
}
