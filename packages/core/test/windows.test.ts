import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PaneManager } from "../src/panes.ts";
import { Store } from "../src/store.ts";
import {
  listDir,
  normalizeUrl,
  parseOverrides,
  readText,
  resolvePaths,
  registerBuiltins,
  shellOpenEnv,
  targetFor,
  WindowManager,
  WindowTypes,
  writeText,
  type WindowType,
} from "../src/windows/index.ts";
import { SpaceManager } from "../src/spaces/manager.ts";
import { fakeFactory } from "./fake-pty.ts";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-win-")));
const file = (name: string, content: string | Buffer) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};
const space = new SpaceManager(null, dir).home();
const builtins = () => {
  const t = new WindowTypes();
  registerBuiltins(t);
  return t;
};
const make = (types = builtins(), overrides: Record<string, string> = {}, db = path.join(dir, "db.sqlite")) => {
  const f = fakeFactory();
  const panes = new PaneManager(f.factory, { socketPath: "/tmp/w.sock", pollMs: 0 });
  return { panes, wins: new WindowManager(panes, new Store(db), types, () => overrides) };
};

describe("window type registry", () => {
  const types = builtins();
  const kindFor = (input: string, overrides: Record<string, string> = {}) => {
    const t = targetFor(input);
    return t ? (types.resolve(t, overrides)?.kind ?? null) : null;
  };

  it("routes folders, web/images/pdf, text and URLs to the built-in types", () => {
    expect(kindFor(dir)).toBe("files");
    expect(kindFor(file("page.html", "<p>hi</p>"))).toBe("browser");
    expect(kindFor(file("shot.PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0])))).toBe("browser");
    expect(kindFor(file("notes.md", "# hi"))).toBe("markdown");
    expect(kindFor(file("notes.txt", "hi"))).toBe("text");
    expect(kindFor(file("Makefile", "all:\n\techo"))).toBe("text");
    expect(kindFor(file("README", "plain text, no extension"))).toBe("text");
    expect(kindFor("https://example.com")).toBe("browser");
  });

  it("leaves binaries, unknown schemes and missing paths alone", () => {
    expect(kindFor(file("app.bin", Buffer.from([1, 2, 0, 3])))).toBeNull();
    expect(kindFor("slack://open")).toBeNull();
    expect(kindFor(path.join(dir, "missing.txt"))).toBeNull();
  });

  it("lets the open.handlers setting override by extension", () => {
    expect(parseOverrides(" .md: browser , log:text")).toEqual({ md: "browser", log: "text" });
    expect(kindFor(path.join(dir, "notes.md"), { md: "browser" })).toBe("browser");
    expect(kindFor(path.join(dir, "notes.md"), { md: "text" })).toBe("text");
  });

  it("takes new types the way a plugin would: a more specific rule wins", () => {
    const t = builtins();
    const preview: WindowType<{ path: string }> = {
      kind: "markdown-preview",
      title: "Markdown Preview",
      icon: "doc.richtext",
      opens: { extensions: ["md"], priority: 20 },
      fromTarget: (tg) => ({ path: tg.type === "path" ? tg.path : "" }),
      create: (input) => ({ state: { path: String(input.path) }, title: "Preview" }),
    };
    t.register(preview);
    expect(() => t.register(preview)).toThrow(/already registered/);
    expect(t.resolve(targetFor(path.join(dir, "notes.md"))!)?.kind).toBe("markdown-preview");
    expect(t.resolve(targetFor(path.join(dir, "README"))!)?.kind).toBe("text"); // others unchanged
    const { wins } = make(t, {}, path.join(dir, "plugin.sqlite"));
    const w = wins.openTarget(path.join(dir, "notes.md"), space)!;
    expect(w).toMatchObject({ kind: "markdown-preview", title: "Preview", state: { path: path.join(dir, "notes.md") } });
    expect(t.info().find((i) => i.kind === "markdown-preview")).toMatchObject({ icon: "doc.richtext", opens: { extensions: ["md"] } });
  });

  it("gives the shell the same rules", () => {
    const env = shellOpenEnv(builtins(), { foo: "text" });
    expect(env.CMD_OPEN_EXTS!.split(" ")).toEqual(expect.arrayContaining(["html", "md", "pdf", "foo"]));
    expect(env).toMatchObject({ CMD_OPEN_HANDLES_FOLDERS: "1", CMD_OPEN_HANDLES_TEXT: "1" });
  });
});

describe("window manager", () => {
  it("normalizes what people type as URLs", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("localhost:3000/app")).toBe("http://localhost:3000/app");
    expect(normalizeUrl("")).toBe("about:blank");
    expect(() => normalizeUrl("not a url")).toThrow();
  });

  it("opens windows with type-owned state, persists them, applies updates through the type", () => {
    const db = path.join(dir, "persist.sqlite");
    const { wins } = make(builtins(), {}, db);
    const b = wins.open("browser", { url: "localhost:5173" }, space);
    const f = wins.open("files", { path: dir }, space);
    expect(b).toMatchObject({ kind: "browser", state: { url: "http://localhost:5173" } });
    expect(f).toMatchObject({ kind: "files", state: { path: dir }, title: path.basename(dir) });
    wins.update(b.id, { state: { url: "example.com" }, title: "Example" });
    expect(() => wins.open("nope", {}, space)).toThrow(/unknown window type/);

    const again = make(builtins(), {}, db).wins; // a restarted core
    expect(again.others().find((w) => w.id === b.id)).toMatchObject({ state: { url: "https://example.com" }, title: "Example" });
    again.close(f.id);
    expect(again.others().map((w) => w.id)).toEqual([b.id]);
  });

  it("switches a window's type in place (Markdown ⇄ text), keeping its id", () => {
    const { wins } = make(builtins(), {}, path.join(dir, "switch.sqlite"));
    const md = file("readme.md", "# Title");
    const w = wins.openTarget(md, space)!;
    expect(w.kind).toBe("markdown");
    const t = wins.update(w.id, { kind: "text" });
    expect(t).toMatchObject({ id: w.id, kind: "text", state: { path: md } });
    expect(wins.update(w.id, { kind: "markdown" })).toMatchObject({ id: w.id, kind: "markdown" });
    expect(() => wins.update(w.id, { kind: "terminal" })).toThrow();
  });

  it("opens untitled text windows that keep a draft until saved to a file", () => {
    const { wins } = make(builtins(), {}, path.join(dir, "untitled.sqlite"));
    const w = wins.open("text", {}, space);
    expect(w).toMatchObject({ kind: "text", title: "Untitled", state: { path: "", dir: path.resolve(space.root), draft: "" } });
    expect(wins.update(w.id, { state: { draft: "hello" } }).state).toMatchObject({ draft: "hello" });
    const saved = file("saved.txt", "hello");
    expect(wins.update(w.id, { state: { path: saved } })).toMatchObject({ title: "saved.txt", state: { path: saved } });
    expect(wins.update(w.id, { state: { draft: "late" } }).state).toEqual({ path: saved });
  });

  it("treats panes as terminal windows", () => {
    const { wins, panes } = make(builtins(), {}, path.join(dir, "term.sqlite"));
    const t = wins.open("terminal", { cwd: dir }, space);
    expect(t).toMatchObject({ kind: "terminal", state: { paneId: t.id } });
    wins.close(t.id);
    expect(panes.get(t.id)).toBeNull();
  });

  it("lists folders first, reads and saves text, refusing outside changes", () => {
    fs.mkdirSync(path.join(dir, "b-folder"), { recursive: true });
    const l = listDir(dir);
    expect(l.entries[0]!.kind).toBe("dir");
    const p = file("edit.txt", "one");
    const r = readText(p);
    const w = writeText(p, "two", r.mtime);
    expect(fs.readFileSync(p, "utf8")).toBe("two");
    fs.utimesSync(p, new Date(), new Date(Date.now() + 5000));
    expect(() => writeText(p, "three", w.mtime)).toThrow(/changed on disk/);
  });
});

describe("resolvePaths", () => {
  it("returns absolute paths for those that exist, relative to cwd", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-resolve-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src", "a.ts"), "");
    expect(resolvePaths(["src/a.ts", "src", "nope.ts", "/"], dir)).toEqual([path.join(dir, "src", "a.ts"), path.join(dir, "src"), null, "/"]);
  });
});
