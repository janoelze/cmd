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

  // A watch isn't live at once (macOS starts its FSEvents stream on another thread): a write
  // right after watch() was nearly always lost (27-30 of 30 before the settle check).
  it("reports a change made right after the watch began, before it was live", async () => {
    const runs = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const own = new WatchService();
        const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-watch-race-")));
        const file = path.join(d, "f.txt");
        fs.writeFileSync(file, "one");
        await new Promise((r) => setTimeout(r, 20));
        const folder = waitFor(own, d, 3000);
        const edited = waitFor(own, file, 3000);
        own.watch(d);
        own.watch(file);
        fs.writeFileSync(path.join(d, `new${i}.txt`), "x");
        fs.writeFileSync(file, "two");
        const r = [await folder, await edited];
        own.close();
        return r;
      }),
    );
    expect(runs.flat().filter((ok) => !ok).length).toBe(0);
  });

  it("reports a change after `since` (when the caller read the folder) made before watch()", async () => {
    svc = new WatchService({ settle: [50] });
    const sub = fs.mkdtempSync(path.join(dir, "since-"));
    const readAt = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(path.join(sub, "late.txt"), "x");
    await new Promise((r) => setTimeout(r, 300)); // long before the watch: no event of its own
    const seen = waitFor(svc, sub, 1500);
    svc.watch(sub, readAt);
    expect(await seen).toBe(true);
  });

  it("reports nothing when nothing changed: not for a folder, its entries or a file", async () => {
    const own = new WatchService();
    const sub = fs.mkdtempSync(path.join(dir, "quiet-"));
    fs.mkdirSync(path.join(sub, "inner"));
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(sub, `f${i}.txt`), "x");
    await new Promise((r) => setTimeout(r, 50));
    const events: string[] = [];
    own.on("changed", (p) => events.push(p));
    own.watch(sub);
    own.watch(path.join(sub, "f1.txt"));
    await new Promise((r) => setTimeout(r, 1400)); // past both settle checks and the debounce
    own.watch(path.join(sub, "f2.txt")); // added once the watch is live: no check
    await new Promise((r) => setTimeout(r, 300));
    own.close();
    expect(events).toEqual([]);
  });
});
