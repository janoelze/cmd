// The Image window's core side (docs/38-image-viewer.md): routing (images
// open here, not in the browser, unless open.handlers says so), and its state.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { IMAGE_EXTENSIONS, imageType, registerBuiltins, targetFor, WindowManager, WindowTypes } from "../src/windows/index.ts";
import { PaneManager } from "../src/panes.ts";
import { Store } from "../src/store.ts";
import { WorkspaceManager } from "../src/workspaces/manager.ts";
import { fakeFactory } from "./fake-pty.ts";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-image-")));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = (name: string) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, "x");
  return p;
};

describe("image window type", () => {
  const types = new WindowTypes();
  registerBuiltins(types);
  const kindFor = (p: string, overrides: Record<string, string> = {}) => types.resolve(targetFor(p)!, overrides)?.kind ?? null;

  it("opens every image format, SVG included, ahead of the browser; open.handlers sends one back", () => {
    for (const ext of IMAGE_EXTENSIONS) expect(kindFor(file(`a.${ext}`))).toBe("image");
    expect(kindFor(file("shot.PNG"))).toBe("image");
    expect(kindFor(file("page.html"))).toBe("browser");
    expect(kindFor(file("a.png"), { png: "browser" })).toBe("browser");
    expect(kindFor(file("a.svg"), { svg: "text" })).toBe("text");
  });

  it("renames the window as ← and → move to another file", () => {
    const panes = new PaneManager(fakeFactory().factory, { socketPath: "/tmp/img.sock", pollMs: 0 });
    const wins = new WindowManager(panes, new Store(path.join(dir, "wins.sqlite")), types, () => ({}));
    const workspace = new WorkspaceManager(null, dir).home();
    const a = file("a.png");
    const b = file("b.png");
    const w = wins.openTarget(a, workspace)!;
    expect(w).toMatchObject({ kind: "image", title: "a.png" });
    expect(wins.update(w.id, { state: { path: b } })).toMatchObject({ title: "b.png", state: { path: b } });
    expect(wins.update(w.id, { state: { zoom: 2 } })).toMatchObject({ title: "b.png", state: { path: b, zoom: 2 } });
    expect(wins.update(w.id, { state: { path: a } })).toMatchObject({ title: "a.png" });
  });

  it("keeps the path and a zoom of fit or a scale, within limits", () => {
    const p = file("photo.jpg");
    expect(imageType.create({ path: p })).toEqual({ state: { path: p }, title: "photo.jpg" });
    expect(imageType.create({ path: p, zoom: 2 }).state).toEqual({ path: p, zoom: 2 });
    expect(imageType.create({ path: p, zoom: "huge" }).state).toEqual({ path: p });
    expect(() => imageType.create({ path: dir })).toThrow(/not a file/);
    const { state } = imageType.create({ path: p });
    expect(imageType.update!(state, { zoom: "fit" }).state).toEqual({ path: p, zoom: "fit" });
    expect(imageType.update!(state, { zoom: 1000 }).state).toEqual({ path: p, zoom: 64 });
    expect(imageType.update!(state, { zoom: 0 }).state).toEqual({ path: p, zoom: 0.01 });
    const q = file("next.png");
    expect(imageType.update!({ ...state, zoom: 2 }, { path: q })).toEqual({ state: { path: q, zoom: 2 }, title: "next.png" });
    expect(() => imageType.update!(state, { path: path.join(dir, "missing.png") })).toThrow();
  });
});
