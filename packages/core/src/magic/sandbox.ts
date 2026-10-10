// Running commands for Magic widgets: the agent's `run` tool and command data
// sources. Every command runs without a PTY, with a timeout and an output cap,
// with secret-looking variables removed from its environment, and under
// sandbox-exec with a profile that denies writes and reading private paths.
//
// sandbox-exec can't apply a profile inside another sandbox (e.g. when the core
// itself runs under Agent Safehouse). Then commands are refused unless the
// caller opts out with sandbox: "off" (CMD_MAGIC_UNSANDBOXED=1 for the CLI),
// leaving the policy (policy.ts) as the only guard.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { expandPath, type Credentials } from "./policy.ts";
import { INSTANCE_PRIVATE_PATTERN, realPathOf } from "../paths-deny.ts";
import { pathReady } from "../loginpath.ts";

export type SandboxMode = "required" | "off";

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBytes?: number;
  sandbox?: SandboxMode;
  deny?: string[];
  signal?: AbortSignal;
  /** Logins the command's CLIs may use (credentialsFor): env kept, config and keychain reachable. */
  credentials?: Credentials;
  /** More folders the command may write (e.g. Deno's cache). */
  writable?: string[];
  /** Text fed to stdin (default: none). */
  stdin?: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  truncated: boolean;
  ms: number;
  sandboxed: boolean;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
let available: boolean | undefined;

/**
 * Can Magic run shell commands here? Not on Windows yet: there is no sandbox
 * (and no /bin/sh), so the agent gets no run tool and command sources are refused.
 */
export function commandsSupported(mode: SandboxMode = "required"): boolean {
  if (process.platform === "win32") return false;
  return mode === "off" || sandboxAvailable();
}

/** Can this process apply a sandbox profile? Probed once. */
export function sandboxAvailable(): boolean {
  if (available === undefined) {
    available =
      process.platform === "darwin" &&
      fs.existsSync(SANDBOX_EXEC) &&
      spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore", timeout: 5000 }).status === 0;
  }
  return available;
}

// Real paths, also of files that don't exist yet: the kernel checks /private/var, not /var.
const real = realPathOf;
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * SBPL profile: everything allowed except writes outside `tmp`, the private
 * paths (also .env files and worktree instances' private files), and a few
 * binaries. With credentials, the CLIs' own config folders stay readable and
 * writable (their caches live there) and, with keychain, the login keychain
 * and /usr/bin/security (how gh and glab fetch their tokens) too.
 */
export function sandboxProfile(o: { tmp: string; deny: string[]; home?: string; credentials?: Credentials; writable?: string[] }): string {
  const home = o.home ?? os.homedir();
  const abs = (p: string) => real(path.resolve(expandPath(p, home)));
  const allowed = (o.credentials?.paths ?? []).map(abs);
  const keychain = !!o.credentials?.keychain;
  const inside = (p: string, root: string) => p === root || p.startsWith(root + path.sep);
  const deny = o.deny
    .map(abs)
    .filter((d) => !allowed.some((a) => inside(d, a) || inside(a, d)) && !(keychain && inside(d, abs("~/Library/Keychains"))));
  const writable = [real(o.tmp), ...allowed, ...(o.writable ?? []).map(abs)];
  const noExec = ["/usr/bin/sudo", "/usr/bin/su", "/usr/bin/osascript", "/usr/bin/open", ...(keychain ? [] : ["/usr/bin/security"])];
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/") ${writable.map((w) => `(subpath ${q(w)})`).join(" ")})`,
    deny.length ? `(deny file-read* ${deny.map((d) => `(subpath ${q(d)})`).join(" ")})` : "",
    `(deny file-read* (regex #"/\\.env(\\.[^/]*)?$"))`,
    `(deny file-read* (regex #"${INSTANCE_PRIVATE_PATTERN}"))`,
    `(deny process-exec ${noExec.map((x) => `(literal ${q(x)})`).join(" ")})`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The environment for commands: the core's, minus anything that looks like a secret (except `keep`). */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env, keep: string[] = []): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION/i.test(k) && !keep.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Run a shell command (sh -c) under the sandbox. Never throws for the command's own failure. */
export function execCommand(command: string, o: ExecOptions = {}): Promise<ExecResult> {
  return execArgv(["/bin/sh", "-c", command], o);
}

/** Run a program with arguments under the sandbox. Never throws for the program's own failure. */
export async function execArgv(cmdArgv: string[], o: ExecOptions = {}): Promise<ExecResult> {
  // Programs are looked up in PATH, which is the login shell's only once that's known.
  await pathReady;
  return execArgvNow(cmdArgv, o);
}

function execArgvNow(cmdArgv: string[], o: ExecOptions): Promise<ExecResult> {
  const mode = o.sandbox ?? "required";
  const sandboxed = mode === "required";
  const start = Date.now();
  if (process.platform === "win32") {
    return Promise.resolve({ stdout: "", stderr: "Running commands isn't supported on Windows yet.", code: null, timedOut: false, truncated: false, ms: 0, sandboxed });
  }
  if (sandboxed && !sandboxAvailable()) {
    return Promise.resolve({
      stdout: "",
      stderr: "cmd can't sandbox commands here (sandbox-exec is unavailable, e.g. inside another sandbox), so it won't run them.",
      code: null,
      timedOut: false,
      truncated: false,
      ms: 0,
      sandboxed,
    });
  }
  const maxBytes = o.maxBytes ?? 64 * 1024;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-magic-"));
  const argv = sandboxed
    ? [SANDBOX_EXEC, "-p", sandboxProfile({ tmp, deny: o.deny ?? [], credentials: o.credentials, writable: o.writable }), ...cmdArgv]
    : cmdArgv;
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: o.cwd && fs.existsSync(o.cwd) ? o.cwd : os.homedir(),
      env: { ...cleanEnv(process.env, o.credentials?.env), ...o.env, TMPDIR: tmp + "/" },
      stdio: [o.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true, // own process group, so a timeout kills pipelines too
    });
    if (o.stdin !== undefined) {
      child.stdin!.on("error", () => {});
      child.stdin!.end(o.stdin);
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    };
    child.stdout!.on("data", (b: Buffer) => {
      if (outBytes >= maxBytes) return void (truncated = true);
      out.push(b);
      outBytes += b.length;
    });
    child.stderr!.on("data", (b: Buffer) => {
      if (errBytes >= 16 * 1024) return;
      err.push(b);
      errBytes += b.length;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs ?? 10_000);
    const onAbort = () => kill();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("close", (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      fs.rm(tmp, { recursive: true, force: true }, () => {});
      let stdout = Buffer.concat(out).toString("utf8");
      if (stdout.length > maxBytes) {
        stdout = stdout.slice(0, maxBytes);
        truncated = true;
      }
      resolve({ stdout, stderr: Buffer.concat(err).toString("utf8"), code, timedOut, truncated, ms: Date.now() - start, sandboxed });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: e.message, code: null, timedOut: false, truncated: false, ms: Date.now() - start, sandboxed });
    });
  });
}
