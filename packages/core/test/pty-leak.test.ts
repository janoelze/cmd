// Real PTYs: a shell that exits gives back every descriptor it took. node-pty
// 1.1.0 kept a pseudo-terminal per spawn on macOS, so a long-lived PTY host used
// up the system's 511 and no app on the Mac could open a terminal.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { nodePtyFactory } from "../src/terminals/pty.ts";

const openFds = (): number => fs.readdirSync("/dev/fd").length;

describe.skipIf(process.platform === "win32")("node-pty", () => {
  it("closes a shell's descriptors when it exits", async () => {
    const factory = await nodePtyFactory();
    const spawnAndExit = () =>
      new Promise<void>((resolve) => {
        const p = factory({ shell: "/bin/sh", args: ["-c", "exit 0"], cwd: "/", cols: 80, rows: 24, env: { PATH: "/usr/bin:/bin" } });
        p.onExit(() => resolve());
      });
    // The first spawn loads the native module and sets up node-pty's own handles.
    await spawnAndExit();
    const before = openFds();
    for (let i = 0; i < 5; i++) await spawnAndExit();
    await new Promise((r) => setTimeout(r, 200));
    expect(openFds()).toBe(before);
  });
});
