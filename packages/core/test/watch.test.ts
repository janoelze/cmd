import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WatchService } from "../src/watch.ts";
import { repeating } from "../../../test/system.ts";

/** Resolves true when `svc` reports `p`, false after `ms`. */
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
/** Resolves when `svc` reports `p`, `write` repeated until then (a write before the watch is live is lost: repeating). */
const sees = (svc: WatchService, p: string, write: () => void) =>
  repeating(`a change to ${path.basename(p)}`, new Promise<void>((r) => svc.on("changed", function h(c) {
    if (c === p) (svc.off("changed", h), r());
  })), write);

describe("WatchService", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-watch-")));
  let svc: WatchService;
  afterEach(() => svc?.close());

  it("sees direct writes and editor-style atomic saves (write temp + rename)", async () => {
    svc = new WatchService();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "one");
    expect(svc.watch(file)).toBe(true);
    await sees(svc, file, () => fs.writeFileSync(file, "two"));
    await sees(svc, file, () => {
      fs.writeFileSync(path.join(dir, ".a.txt.tmp"), "three");
      fs.renameSync(path.join(dir, ".a.txt.tmp"), file);
    });
  });

  it("reports folder changes and stops after the last unwatch", async () => {
    svc = new WatchService();
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub);
    svc.watch(sub);
    svc.watch(sub); // two windows
    await sees(svc, sub, () => fs.writeFileSync(path.join(sub, "new.txt"), "x"));
    svc.unwatch(sub);
    await sees(svc, sub, () => fs.writeFileSync(path.join(sub, "new2.txt"), "x")); // still one watcher left
    svc.unwatch(sub);
    await new Promise((r) => setTimeout(r, 200)); // reports already debounced (80 ms) from the repeated writes fire first
    const seen = waitFor(svc, sub, 600);
    fs.writeFileSync(path.join(sub, "new3.txt"), "x");
    expect(await seen).toBe(false);
  });
});
