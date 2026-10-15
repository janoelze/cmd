// cmd.run (API 1.1, docs/56 "The runtime": Deno gets no permission to run programs): a widget runs a program
// through the core, never itself. The program must be one the grant names (`run: ["gh"]`), by
// its bare name; its arguments reach it as they are (execArgv, no shell between), judged by
// lib/policy.ts's rules for one simple command, so only read-only commands run (`gh run list`
// yes; `docker run -v /:/h`, `git -c alias.x=!…` no, with the policy's reason). It runs under
// lib/sandbox.ts's profile (no writes, no network but what its CLI's login needs), in the
// workspace's folder or one the grant reads, bounded in time, output, concurrency and rate,
// and what it prints has tokens blanked (lib/redact.ts) before the widget sees it.

import os from "node:os";
import path from "node:path";
import type { ApiRunOptions, ApiRunResult, WidgetPermissions } from "@cmd/protocol";
import { classifyArgs, credentialsForPrograms, ESCAPES, expandPath, redact } from "../../lib/policy.ts";
import { isDeniedPath, magicDenyPaths } from "../../lib/paths-deny.ts";
import { execArgv, sandboxMode, type ExecOptions, type ExecResult, type SandboxMode } from "../../lib/sandbox.ts";
import { RateLimit, failed, invalid, missing } from "./access.ts";

/** The bounds of one run (the d.ts says them: cmd.ts's `Run`). */
export const RUN_LIMITS = { timeoutMs: 10_000, maxTimeoutMs: 30_000, stdout: 64 * 1024, stderr: 16 * 1024, args: 64, argLength: 4096, atOnce: 2, perMinute: 30 } as const;

export interface RunScope {
  permissions: WidgetPermissions;
  /** The widget's workspace's folder (null: none, the home folder then). */
  root(): string | null;
  /** Tests: run something else than execArgv. */
  exec?: (argv: string[], o: ExecOptions) => Promise<ExecResult>;
}

/** Whether runs go through sandbox-exec: lib/sandbox.ts's one rule. */
export const runSandbox = (): SandboxMode => sandboxMode();

const inside = (dir: string, p: string) => p === dir || p.startsWith(dir + path.sep);

/** One widget process's runs: its limits, kept across calls. */
export function widgetRunner(scope: RunScope): (program: unknown, args: unknown, opts: unknown) => Promise<ApiRunResult> {
  const rate = new RateLimit(RUN_LIMITS.perMinute);
  let running = 0;

  return async (program, args, opts) => {
    if (typeof program !== "string" || !/^[\w.-]+$/.test(program)) throw invalid("cmd.run: name a program by its name, like \"gh\", and its arguments as a list");
    if (!scope.permissions.run.includes(program) || ESCAPES.has(program)) throw missing("run", program, `Running ${program}`);
    const argv = args === undefined || args === null ? [] : args;
    if (!Array.isArray(argv) || argv.length > RUN_LIMITS.args || argv.some((a) => typeof a !== "string" || a.length > RUN_LIMITS.argLength || a.includes("\0")))
      throw invalid(`cmd.run: the arguments are a list of at most ${RUN_LIMITS.args} strings`);
    const o = (opts && typeof opts === "object" ? opts : {}) as ApiRunOptions;
    const home = os.homedir();
    const root = scope.root();
    const cwd = folder(o.cwd, root ?? home, root, scope.permissions.read.map((r) => path.resolve(expandPath(r, home))));
    const verdict = classifyArgs(program, argv as string[], { cwd });
    if (verdict.level !== "allow") throw invalid(`cmd.run won't run ${[program, ...(argv as string[])].join(" ").slice(0, 120)}: ${verdict.reason}. Widgets run read-only commands only.`);
    if (running >= RUN_LIMITS.atOnce) throw failed(`cmd.run: at most ${RUN_LIMITS.atOnce} at once; wait for one to end.`);
    rate.take("cmd.run");
    const timeoutMs = Math.max(100, Math.min(Math.floor(Number(o.timeoutMs) || RUN_LIMITS.timeoutMs), RUN_LIMITS.maxTimeoutMs));
    running++;
    let r: ExecResult;
    try {
      r = await (scope.exec ?? execArgv)([program, ...(argv as string[])], { cwd, timeoutMs, maxBytes: RUN_LIMITS.stdout, sandbox: runSandbox(), deny: magicDenyPaths(), credentials: credentialsForPrograms([program]) });
    } finally {
      running--;
    }
    // It never started (no sandbox here, no such program): the widget gets why, as a failure.
    if (r.code === null && !r.timedOut && !r.stdout) throw failed(`cmd.run: ${redact(r.stderr.trim()).slice(0, 300) || `${program} didn't start`}`);
    const stderr = r.stderr.length > RUN_LIMITS.stderr ? r.stderr.slice(0, RUN_LIMITS.stderr) : r.stderr;
    return { code: r.timedOut ? null : r.code, stdout: redact(r.stdout), stderr: redact(stderr), timedOut: r.timedOut, clipped: r.truncated || stderr.length < r.stderr.length };
  };
}

/** Where a run happens: the default, or a folder inside the workspace's or a granted `read` one, never a private one. */
function folder(asked: unknown, fallback: string, root: string | null, read: string[]): string {
  if (asked === undefined || asked === null || asked === "") return fallback;
  if (typeof asked !== "string") throw invalid("cmd.run: cwd is a folder's path");
  const abs = path.resolve(root ?? os.homedir(), expandPath(asked, os.homedir()));
  if (!(root && inside(root, abs)) && !read.some((r) => inside(r, abs))) throw invalid(`cmd.run: ${asked.slice(0, 120)} is outside the workspace's folder and the folders this widget reads`);
  if (isDeniedPath(abs, magicDenyPaths())) throw invalid(`cmd.run: ${asked.slice(0, 120)} stays private`);
  return abs;
}
