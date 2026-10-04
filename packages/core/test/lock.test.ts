// One core per state dir (lock.ts): a held lock refuses others, in this process
// and in another, and the kernel frees it when the holder dies however it dies.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock } from "../src/lock.ts";
import { rmTemp } from "./tmp.ts";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-lock-"));
});
afterEach(() => rmTemp(dir));

/** A process that takes the lock, says "held" and waits to be killed. */
function holder(file: string) {
  const code = `const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(${JSON.stringify(file)});d.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;");console.log("held");setInterval(()=>{},1000)`;
  const child = spawn(process.execPath, ["--no-warnings", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  const held = new Promise<void>((r) => child.stdout.once("data", () => r()));
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  return { child, held, exited };
}

describe("instance lock", () => {
  it("refuses a second holder until the first releases it", () => {
    const file = path.join(dir, "core.lock");
    const a = acquireLock(file)!;
    expect(a).not.toBeNull();
    expect(acquireLock(file)).toBeNull();
    a.release();
    const b = acquireLock(file);
    expect(b).not.toBeNull();
    b!.release();
  });

  it("is freed when the process holding it is killed", async () => {
    const file = path.join(dir, "core.lock");
    const h = holder(file);
    await h.held;
    expect(acquireLock(file)).toBeNull();
    h.child.kill("SIGKILL");
    await h.exited;
    const lock = acquireLock(file);
    expect(lock).not.toBeNull();
    lock!.release();
  });
});
