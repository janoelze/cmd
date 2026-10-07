// The Node side of helper/tour-helper.swift: builds it when its source is newer
// than the binary, then sends it JSON commands one at a time and resolves with
// each reply. The helper keeps the tour's clock (see its header).

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const SOURCE = path.join(import.meta.dirname, "..", "helper", "tour-helper.swift");

export function buildHelper(): string {
  const bin = path.join(os.tmpdir(), "cmd-tours", "tour-helper");
  if (!fs.existsSync(bin) || fs.statSync(SOURCE).mtimeMs > fs.statSync(bin).mtimeMs) {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    execFileSync("swiftc", ["-O", SOURCE, "-o", bin], { stdio: "inherit" });
  }
  return bin;
}

export type Reply = { ok: boolean; error?: string } & Record<string, unknown>;

export class Helper {
  private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void }[] = [];
  private proc: ChildProcessWithoutNullStreams;

  private constructor(proc: ChildProcessWithoutNullStreams) {
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      const w = this.waiting.shift();
      if (!w) return;
      let r: Reply;
      try {
        r = JSON.parse(line) as Reply;
      } catch {
        return w.reject(new Error(`tour-helper: ${line}`));
      }
      if (r.ok) w.resolve(r);
      else w.reject(new Error(`tour-helper: ${r.error ?? "failed"}`));
    });
    proc.stderr.on("data", (d: Buffer) => process.stderr.write(`tour-helper: ${d}`));
    proc.on("exit", (code) => {
      for (const w of this.waiting.splice(0)) w.reject(new Error(`tour-helper exited (${code})`));
    });
  }

  static start(): Helper {
    return new Helper(spawn(buildHelper(), [], { stdio: ["pipe", "pipe", "pipe"] }));
  }

  /** One command; replies come back in the order commands were sent. */
  call(cmd: string, args: Record<string, unknown> = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.proc.stdin.write(JSON.stringify({ cmd, ...args }) + "\n");
    });
  }

  /** The helper's clock, ns: the clock of the video's frames. */
  async now(): Promise<number> {
    return (await this.call("now")).now as number;
  }

  close() {
    this.proc.stdin.end();
  }
}
