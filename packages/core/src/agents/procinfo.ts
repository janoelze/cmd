// Foreground-process inspection via the native `procinfo` helper (native/procinfo.c).
// Port of the ghostty-agents fork's AgentProcess.swift: classify by full argv so
// wrappers like `bash …/safehouse … claude`, `sandbox-exec … claude` and
// `node …/bin/codex` are recognized.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { lineSplitter } from "@cmd/protocol";

export interface ForegroundInfo {
  /** Foreground process group leader of the terminal. */
  pid: number;
  /** Process start time, unix ms. */
  startedAt: number;
  path: string;
  argv: string[];
}

export type Classification =
  | { kind: "agent"; agent: string }
  | { kind: "shell" }
  | { kind: "other"; name: string };

const KNOWN_AGENTS = [
  "claude",
  "codex",
  "gemini",
  "aider",
  "opencode",
  "amp",
  "cursor-agent",
  "goose",
  "crush",
  "qwen",
  "droid",
] as const;

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "xonsh", "elvish", "pwsh", "powershell", "login"]);
// Only on Windows: elsewhere `cmd` is this app's own CLI.
if (process.platform === "win32") SHELLS.add("cmd");

/** Last path component, either separator, without a Windows `.exe`. */
const basename = (s: string) => (s.split(/[\\/]/).pop() ?? s).replace(/\.exe$/i, "");

/**
 * Agents are checked before shells because wrapper scripts start with a shell
 * (`bash …/safehouse … claude`). Native Claude installs run from
 * `…/claude/versions/<v>`, so path components are checked too.
 */
export function classify(info: Pick<ForegroundInfo, "path" | "argv">): Classification {
  const candidates = [...info.argv.map(basename), basename(info.path), ...info.path.split(/[\\/]/)];
  for (const c of candidates) {
    const hit = KNOWN_AGENTS.find((a) => a === c);
    if (hit) return { kind: "agent", agent: hit };
  }
  const first = basename(info.argv[0] ?? info.path).replace(/^-+/, "");
  if (SHELLS.has(first)) return { kind: "shell" };
  return { kind: "other", name: first || basename(info.path) };
}

/** Name shown for a pane's foreground process. */
export function displayName(c: Classification, info: Pick<ForegroundInfo, "path" | "argv">): string {
  if (c.kind === "agent") return c.agent;
  return basename(info.argv[0] ?? info.path).replace(/^-+/, "");
}

export function procinfoBinary(): string {
  return path.resolve(import.meta.dirname, "../../native/build/procinfo");
}

/** Resource usage of one process tree (see procinfo.c, `t` command). */
export interface TreeUsage {
  pid: number;
  /** Physical footprint in bytes (Activity Monitor's "Memory"). */
  mem: number;
  /** Cumulative user+system CPU time, ns. */
  cpu: number;
  procs: number;
  top: { pid: number; name: string; path: string; mem: number }[];
}

/** Long-lived helper process; one request/response line per query. */
export class ProcInfo {
  #child: ChildProcessWithoutNullStreams | null = null;
  /** Pending requests, answered in order; each parses its own response line. */
  #queue: ((line: string | null) => void)[] = [];
  #binary: string;

  constructor(binary = procinfoBinary()) {
    this.#binary = binary;
  }

  get available(): boolean {
    return fs.existsSync(this.#binary);
  }

  /** Foreground process of the terminal whose shell is `shellPid`. */
  query(shellPid: number): Promise<ForegroundInfo | null> {
    const child = this.#ensure();
    if (!child) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.#queue.push((line) => {
        if (!line) return resolve(null);
        try {
          const r = JSON.parse(line) as { fg?: number; start?: number; path?: string; argv?: string[]; error?: string };
          resolve(r.error || !r.fg ? null : { pid: r.fg, startedAt: Math.round((r.start ?? 0) * 1000), path: r.path ?? "", argv: r.argv ?? [] });
        } catch {
          resolve(null);
        }
      });
      child.stdin.write(`${shellPid}\n`);
    });
  }

  /** Memory/CPU of each pid's process tree, from one scan of the process table. */
  trees(pids: number[]): Promise<TreeUsage[]> {
    const child = this.#ensure();
    if (!child || pids.length === 0) return Promise.resolve([]);
    return new Promise((resolve) => {
      this.#queue.push((line) => {
        try {
          resolve(line ? (JSON.parse(line) as TreeUsage[]) : []);
        } catch {
          resolve([]);
        }
      });
      child.stdin.write(`t ${pids.join(" ")}\n`);
    });
  }

  close(): void {
    this.#child?.kill();
    this.#child = null;
  }

  #ensure(): ChildProcessWithoutNullStreams | null {
    if (this.#child) return this.#child;
    if (!this.available) return null;
    const child = spawn(this.#binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on(
      "data",
      lineSplitter((line) => {
        this.#queue.shift()?.(line);
      }),
    );
    const fail = () => {
      this.#child = null;
      for (const r of this.#queue.splice(0)) r(null);
    };
    child.on("exit", fail);
    child.on("error", fail);
    child.unref();
    (child.stdin as unknown as { unref?: () => void }).unref?.();
    (child.stdout as unknown as { unref?: () => void }).unref?.();
    this.#child = child;
    return child;
  }
}
