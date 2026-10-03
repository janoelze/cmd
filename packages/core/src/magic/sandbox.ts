// Running commands for Magic windows: the agent's `run` tool and command data
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

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * SBPL profile: everything allowed except writes outside `tmp`, the private
 * paths, and a few binaries. With credentials, the CLIs' own config folders stay
 * readable and writable (their caches live there) and, with keychain, the login
 * keychain and /usr/bin/security (how gh and glab fetch their tokens) too.
 */
export function sandboxProfile(o: { tmp: string; deny: string[]; home?: string; credentials?: Credentials }): string {
  const home = o.home ?? os.homedir();
  const abs = (p: string) => real(path.resolve(expandPath(p, home)));
  const allowed = (o.credentials?.paths ?? []).map(abs);
  const keychain = !!o.credentials?.keychain;
  const inside = (p: string, root: string) => p === root || p.startsWith(root + "/");
  const deny = o.deny
    .map(abs)
    .filter((d) => !allowed.some((a) => inside(d, a) || inside(a, d)) && !(keychain && inside(d, abs("~/Library/Keychains"))));
  const writable = [real(o.tmp), ...allowed];
  const noExec = ["/usr/bin/sudo", "/usr/bin/su", "/usr/bin/osascript", "/usr/bin/open", ...(keychain ? [] : ["/usr/bin/security"])];
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/") ${writable.map((w) => `(subpath ${q(w)})`).join(" ")})`,
    deny.length ? `(deny file-read* ${deny.map((d) => `(subpath ${q(d)})`).join(" ")})` : "",
    `(deny file-read* (regex #"/\\.env(\\.[^/]*)?$"))`,
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
  const mode = o.sandbox ?? "required";
  const sandboxed = mode === "required";
  const start = Date.now();
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
    ? [SANDBOX_EXEC, "-p", sandboxProfile({ tmp, deny: o.deny ?? [], credentials: o.credentials }), "/bin/sh", "-c", command]
    : ["/bin/sh", "-c", command];
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: o.cwd && fs.existsSync(o.cwd) ? o.cwd : os.homedir(),
      env: { ...cleanEnv(process.env, o.credentials?.env), TMPDIR: tmp + "/" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group, so a timeout kills pipelines too
    });
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
    child.stdout.on("data", (b: Buffer) => {
      if (outBytes >= maxBytes) return void (truncated = true);
      out.push(b);
      outBytes += b.length;
    });
    child.stderr.on("data", (b: Buffer) => {
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
