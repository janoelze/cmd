import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PaneManager } from "../src/panes.ts";
import { Store } from "../src/store.ts";
import { listDir, normalizeUrl, WindowManager } from "../src/windows.ts";
import { fakeFactory } from "./fake-pty.ts";

describe("windows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-win-"));
  const dbFile = path.join(dir, "db.sqlite");
  const make = () => {
    const f = fakeFactory();
    const panes = new PaneManager(f.factory, { socketPath: "/tmp/w.sock", pollMs: 0 });
    return { panes, wins: new WindowManager(panes, new Store(dbFile)) };
  };

  it("normalizes what people type as URLs", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("localhost:3000/app")).toBe("http://localhost:3000/app");
    expect(normalizeUrl("http://x.test")).toBe("http://x.test");
    expect(normalizeUrl("")).toBe("about:blank");
    expect(() => normalizeUrl("not a url")).toThrow();
  });

  it("opens browser and file windows, persists them across restarts, closes them", () => {
    const { wins } = make();
    const events: string[] = [];
    wins.on("updated", (w) => events.push(`u:${w.kind}`));
    wins.on("removed", () => events.push("removed"));
    const b = wins.open({ kind: "browser", url: "localhost:5173" });
    const f = wins.open({ kind: "files", path: dir });
    expect(b).toMatchObject({ kind: "browser", url: "http://localhost:5173" });
    expect(f).toMatchObject({ kind: "files", path: dir, title: path.basename(dir) });
    wins.update(b.id, { url: "https://example.com", title: "Example" });

    const again = make().wins; // a restarted core
    expect(again.others().find((w) => w.id === b.id)).toMatchObject({ url: "https://example.com", title: "Example" });
    again.close(f.id);
    expect(again.others().map((w) => w.id)).toEqual([b.id]);
    expect(events).toEqual(["u:browser", "u:files", "u:browser"]);
  });

  it("treats panes as terminal windows", () => {
    const { wins, panes } = make();
    const t = wins.open({ kind: "terminal", cwd: dir });
    expect(t).toMatchObject({ kind: "terminal", paneId: t.id });
    expect(wins.list().some((w) => w.id === t.id && w.kind === "terminal")).toBe(true);
    wins.close(t.id);
    expect(panes.get(t.id)).toBeNull();
  });

  it("lists folders first, with hidden flags", () => {
    fs.mkdirSync(path.join(dir, "b-folder"));
    fs.writeFileSync(path.join(dir, "a-file.txt"), "hi");
    fs.writeFileSync(path.join(dir, ".hidden"), "");
    const l = listDir(dir);
    expect(l.parent).toBe(path.dirname(dir));
    const names = l.entries.map((e) => e.name);
    expect(names.indexOf("b-folder")).toBeLessThan(names.indexOf("a-file.txt"));
    expect(l.entries.find((e) => e.name === ".hidden")!.hidden).toBe(true);
    expect(l.entries.find((e) => e.name === "a-file.txt")).toMatchObject({ kind: "file", size: 2 });
  });
});
