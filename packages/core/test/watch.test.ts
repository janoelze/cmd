import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WatchService } from "../src/watch.ts";

const waitFor = (svc: WatchService, p: string, ms = 3000) =>
  new Promise<boolean>((resolve) => {
    const t = setTimeout(() => (svc.off("changed", h), resolve(false)), ms);
    const h = (changed: string) => {
      if (changed === p) {
        clearTimeout(t);
        svc.off("changed", h);
        resolve(true);
      }
    };
    svc.on("changed", h);
  });

describe("WatchService", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-watch-")));
  let svc: WatchService;
  afterEach(() => svc?.close());

  it("sees direct writes and editor-style atomic saves (write temp + rename)", async () => {
    svc = new WatchService();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "one");
    expect(svc.watch(file)).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    let seen = waitFor(svc, file);
    fs.writeFileSync(file, "two");
    expect(await seen).toBe(true);
    seen = waitFor(svc, file);
    fs.writeFileSync(path.join(dir, ".a.txt.tmp"), "three");
    fs.renameSync(path.join(dir, ".a.txt.tmp"), file);
    expect(await seen).toBe(true);
  });

  it("reports folder changes and stops after the last unwatch", async () => {
    svc = new WatchService();
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub);
    svc.watch(sub);
    svc.watch(sub); // two windows
    await new Promise((r) => setTimeout(r, 100));
    let seen = waitFor(svc, sub);
    fs.writeFileSync(path.join(sub, "new.txt"), "x");
    expect(await seen).toBe(true);
    svc.unwatch(sub);
    seen = waitFor(svc, sub);
    fs.writeFileSync(path.join(sub, "new2.txt"), "x");
    expect(await seen).toBe(true); // still one watcher left
    svc.unwatch(sub);
    seen = waitFor(svc, sub, 600);
    fs.writeFileSync(path.join(sub, "new3.txt"), "x");
    expect(await seen).toBe(false);
  });
});
