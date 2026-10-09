import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PaneManager } from "../src/panes.ts";
import { Store } from "../src/store.ts";
import {
  listDir,
  normalizeUrl,
  parseYouTube,
  parseOverrides,
  readText,
  resolvePaths,
  registerBuiltins,
  shellOpenEnv,
  targetFor,
  WindowManager,
  WindowTypes,
  writeText,
  youtubeType,
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

  it("routes folders, web/images, PDFs, text and URLs to the built-in types", () => {
    expect(kindFor(dir)).toBe("files");
    expect(kindFor(file("page.html", "<p>hi</p>"))).toBe("browser");
    expect(kindFor(file("shot.PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0])))).toBe("image");
    expect(kindFor(path.join(dir, "shot.PNG"), { png: "browser" })).toBe("browser");
    expect(kindFor(file("notes.md", "# hi"))).toBe("markdown");
    expect(kindFor(file("data.json", "{}"))).toBe("json");
    expect(kindFor(file("data.json", "{}"), { json: "text" })).toBe("text");
    expect(kindFor(file("paper.PDF", "%PDF-1.7\n"))).toBe("pdf");
    expect(kindFor(file("notes.txt", "hi"))).toBe("text");
    expect(kindFor(file("Makefile", "all:\n\techo"))).toBe("text");
    expect(kindFor(file("README", "plain text, no extension"))).toBe("text");
    expect(kindFor("https://example.com")).toBe("browser");
  });

  it("keeps a PDF window's place: page, zoom, sidebar, dark pages", () => {
    const pdf = types.get("pdf")!;
    const f = file("doc.pdf", "%PDF-1.7\n");
    const { state, title } = pdf.create({ path: f, page: 3 });
    expect(title).toBe("doc.pdf");
    expect(state).toEqual({ path: f, page: 3 });
    const next = pdf.update!(state, { page: 7.6, scale: "page-width", sidebar: "outline", dark: true }).state;
    expect(next).toEqual({ path: f, page: 7, scale: "page-width", sidebar: "outline", dark: true });
    // Nonsense is ignored, not stored.
    expect(pdf.update!(next, { page: 0, scale: 99, sidebar: "thumbs", dark: "yes" }).state).toEqual(next);
    expect(pdf.update!(next, { scale: 1.5, sidebar: null }).state).toMatchObject({ scale: 1.5, sidebar: null });
    expect(() => pdf.create({ path: path.join(dir, "missing.pdf") })).toThrow();
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
    const home = pathToFileURL(os.homedir()).href;
    expect(normalizeUrl("file://~/web/a.html#x")).toBe(`${home}/web/a.html#x`);
    expect(normalizeUrl("~/web/a.html")).toBe(`${home}/web/a.html`);
    expect(normalizeUrl("/tmp/a.html")).toBe("file:///tmp/a.html");
    expect(normalizeUrl("file:///tmp/a.html")).toBe("file:///tmp/a.html");
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

  it("keeps a browser window's device size until it is cleared", () => {
    const { wins } = make(builtins(), {}, path.join(dir, "device.sqlite"));
    const b = wins.open("browser", { url: "example.com" }, space);
    expect(wins.update(b.id, { state: { device: "iphone-16" } }).state).toEqual({ url: "https://example.com", device: "iphone-16" });
    expect(wins.update(b.id, { state: { url: "localhost:3000" } }).state).toMatchObject({ device: "iphone-16" });
    expect(wins.update(b.id, { state: { device: null } }).state).toEqual({ url: "http://localhost:3000" });
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

  it("opens JSON and JSON Lines as a tree that switches to the editor at a line", () => {
    const { wins } = make(builtins(), {}, path.join(dir, "json.sqlite"));
    for (const name of ["data.json", "log.jsonl", "events.ndjson", "tsconfig.jsonc"]) expect(wins.openTarget(file(name, "{}"), space)!.kind).toBe("json");
    const j = file("package.json", '{"name":"cmd"}');
    const w = wins.openTarget(j, space)!;
    expect(w).toMatchObject({ kind: "json", title: "package.json", state: { path: j } });
    const t = wins.update(w.id, { kind: "text", state: { reveal: { line: 3, column: null, text: null, at: 1 } } });
    expect(t).toMatchObject({ id: w.id, kind: "text", state: { path: j, reveal: { line: 3 } } });
    const back = wins.update(w.id, { kind: "json", state: { reveal: { line: 2 } } });
    expect(back).toMatchObject({ id: w.id, kind: "json", state: { path: j, reveal: { line: 2 } } });
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

describe("youtube widget", () => {
  it("reads ids, links and embed codes", () => {
    const id = "dQw4w9WgXcQ";
    expect(parseYouTube(id)).toEqual({ video: id });
    expect(parseYouTube(` https://www.youtube.com/watch?v=${id}&t=1m30s `)).toEqual({ video: id, start: 90 });
    expect(parseYouTube(`youtube.com/watch?v=${id}&list=PLabc_-1`)).toEqual({ video: id, list: "PLabc_-1" });
    expect(parseYouTube(`https://youtu.be/${id}?t=42`)).toEqual({ video: id, start: 42 });
    expect(parseYouTube(`https://m.youtube.com/shorts/${id}`)).toEqual({ video: id });
    expect(parseYouTube(`https://music.youtube.com/watch?v=${id}`)).toEqual({ video: id });
    expect(parseYouTube(`https://www.youtube.com/live/${id}?si=x`)).toEqual({ video: id });
    expect(parseYouTube("https://www.youtube.com/playlist?list=PLabc")).toEqual({ list: "PLabc" });
    expect(
      parseYouTube(`<iframe width="560" height="315" src="https://www.youtube-nocookie.com/embed/${id}?si=a&amp;start=5" title="YouTube video player" allowfullscreen></iframe>`),
    ).toEqual({ video: id, start: 5 });
    expect(parseYouTube(`<iframe src="https://www.youtube.com/embed/videoseries?list=PLabc"></iframe>`)).toEqual({ list: "PLabc" });
    for (const bad of ["", "hello", "https://vimeo.com/123", "https://www.youtube.com/@channel", "https://youtube.com/watch?v=short"]) expect(parseYouTube(bad)).toBeNull();
  });

  it("starts empty, takes a link, and refuses what isn't one", () => {
    expect(youtubeType.create({}).state).toEqual({});
    const { state } = youtubeType.create({ input: "https://youtu.be/dQw4w9WgXcQ" });
    expect(state).toEqual({ video: "dQw4w9WgXcQ" });
    expect(youtubeType.update!(state, { input: "https://youtu.be/aaaaaaaaaaa?t=3" }).state).toEqual({ video: "aaaaaaaaaaa", start: 3 });
    expect(youtubeType.update!(state, { input: null }).state).toEqual({});
    expect(youtubeType.update!(state, {}).state).toEqual(state);
    // Fill is the default; letterboxing sticks across another video and Change Video.
    const boxed = youtubeType.update!(state, { fill: false }).state;
    expect(boxed).toEqual({ video: "dQw4w9WgXcQ", fill: false });
    expect(youtubeType.update!(boxed, { input: "aaaaaaaaaaa" }).state).toEqual({ video: "aaaaaaaaaaa", fill: false });
    expect(youtubeType.update!(boxed, { input: null }).state).toEqual({ fill: false });
    expect(youtubeType.update!(boxed, { fill: true }).state).toEqual({ video: "dQw4w9WgXcQ" });
    expect(() => youtubeType.update!(state, { input: "nope" })).toThrow(/not a YouTube link/);
  });
});
