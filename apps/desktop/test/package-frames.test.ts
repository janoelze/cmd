// Frame widgets' pages (main/package-frames.ts): only files inside the package folder are
// served (`..`, encoded or not, a dot-file, a link out of the folder: nothing), view.html gets
// the prelude with the theme and the page's `cmd`, under a CSP without network but the grant's
// media hosts; the page's `cmd` (package-frame/frame.js) has every verb and live topic of the
// protocol's registry under the process API's names, its calls and subscriptions posted to the
// app and answered; and the one frame host's gesture rule (lib/frames.ts, AR1-11-05): an action
// with no press before it does nothing, one press gives one action, at most one a second.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_TOPICS, API_VERBS } from "@cmd/protocol";
import { isPackageFramePage, mediaOrigins, packageCsp, packageFrameResponse, registerPackageFrame, resolveInPackage } from "../src/main/package-frames.ts";
import { Gesture, type GestureEnv } from "../src/renderer/src/lib/frames.ts";

function pkg(): { root: string; outside: string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-frame-")));
  const root = path.join(base, "radio");
  fs.mkdirSync(path.join(root, "img"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "view.html"), "<p id=x>hi</p>");
  fs.writeFileSync(path.join(root, "img", "a b.png"), "png");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
  const outside = path.join(base, "secret.txt");
  fs.writeFileSync(outside, "secret");
  fs.symlinkSync(outside, path.join(root, "link.txt"));
  fs.symlinkSync(base, path.join(root, "up"));
  return { root, outside };
}

describe("a frame widget's files", () => {
  it("are served from inside the package folder only", () => {
    const { root } = pkg();
    expect(resolveInPackage(root, "")).toBe(path.join(root, "view.html"));
    expect(resolveInPackage(root, "view.html")).toBe(path.join(root, "view.html"));
    expect(resolveInPackage(root, "img/a%20b.png")).toBe(path.join(root, "img", "a b.png"));
    for (const bad of ["../secret.txt", "img/../../secret.txt", "%2e%2e/secret.txt", "..%2fsecret.txt", "img%2f..%2f..%2fsecret.txt", "..%5csecret.txt", ".env", "link.txt", "up/secret.txt", "img", "nope.js", "%E0%A4%A"])
      expect(resolveInPackage(root, bad), bad).toBeNull();
  });

  it("come through the scheme under their token, view.html with its prelude and a CSP without network", async () => {
    const { root } = pkg();
    const url = registerPackageFrame({ dir: root, media: ["stream.example.com", "localhost:8080", "bad host/x"], init: { appearance: "light", vars: { "--text": "#111", "--bad": "red;}</style>" }, state: { volume: "</script><script>alert(1)" }, config: {} } });
    expect(url).toMatch(/^cmd-widget:\/\/package\/[0-9a-f-]{36}\/view\.html$/);
    expect(isPackageFramePage(url)).toBe(true);
    const page = await packageFrameResponse(new Request(url));
    const html = await page.text();
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(html).toMatch(/^<!doctype html><html data-appearance="light">/);
    expect(html).toContain("--text:#111");
    expect(html).not.toContain("--bad");
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("window.cmd = cmd;");
    expect(html).toContain('"verbs":["workspace.get"');
    expect(html.trimEnd().endsWith("<p id=x>hi</p>")).toBe(true);
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src cmd-widget:;");
    expect(csp).toContain("media-src cmd-widget: data: blob: http://localhost:8080 https://localhost:8080 https://stream.example.com");
    expect(csp).not.toMatch(/connect-src[^;]*https/);
    const img = await packageFrameResponse(new Request(url.replace("view.html", "img/a%20b.png")));
    expect([img.status, img.headers.get("content-type")]).toEqual([200, "image/png"]);
    for (const p of ["../secret.txt", "%2e%2e/%2e%2e/secret.txt", "link.txt", ".env"]) expect((await packageFrameResponse(new Request(url.replace("view.html", p)))).status, p).toBe(404);
    expect((await packageFrameResponse(new Request("cmd-widget://package/not-a-token/view.html"))).status).toBe(404);
    expect(isPackageFramePage(url.replace("view.html", "other.html"))).toBe(false);
  });

  it("serve a Frame element's page with the prelude, and only an .html file of the package; a story's page inline", async () => {
    const { root } = pkg();
    fs.mkdirSync(path.join(root, "pages"));
    fs.writeFileSync(path.join(root, "pages", "meter.html"), "<canvas></canvas>");
    const init = { appearance: "dark" as const, vars: {}, state: {}, config: {}, data: { values: [1, 2] } };
    const url = registerPackageFrame({ dir: root, page: "pages/meter.html", media: [], init });
    expect(url).toMatch(/\/pages\/meter\.html$/);
    expect(isPackageFramePage(url)).toBe(true);
    expect(isPackageFramePage(url.replace("pages/meter.html", "view.html"))).toBe(false);
    const html = await (await packageFrameResponse(new Request(url))).text();
    expect(html).toContain('"data":{"values":[1,2]}');
    expect(html.trimEnd().endsWith("<canvas></canvas>")).toBe(true);
    // view.html under this token is a file of the package, not its page: no prelude.
    expect(await (await packageFrameResponse(new Request(url.replace("pages/meter.html", "view.html")))).text()).toBe("<p id=x>hi</p>");
    for (const page of ["../secret.txt", "nope.html", "img/a b.png", ".env"]) expect(() => registerPackageFrame({ dir: root, page, media: [], init }), page).toThrow();
    const inline = registerPackageFrame({ html: "<b>story</b>", media: [], init });
    expect((await (await packageFrameResponse(new Request(inline))).text()).trimEnd().endsWith("<b>story</b>")).toBe(true);
    expect((await packageFrameResponse(new Request(inline.replace("page.html", "view.html")))).status).toBe(404);
  });

  it("refuse a folder that isn't a package", () => {
    expect(() => registerPackageFrame({ dir: "relative", media: [], init: { appearance: "dark", vars: {}, state: {}, config: {} } })).toThrow();
    expect(() => registerPackageFrame({ dir: os.tmpdir(), media: [], init: { appearance: "dark", vars: {}, state: {}, config: {} } })).toThrow(/not a widget package/);
  });

  it("media origins and the CSP", () => {
    expect(mediaOrigins(["a.example.com", "*.cdn.example", "*", "x y"])).toEqual(["https:", "https://*.cdn.example", "https://a.example.com"]);
    expect(packageCsp([])).toContain("img-src cmd-widget: data: blob:;");
  });
});

describe("the frame host's gesture rule", () => {
  function gesture(o: Partial<{ focused: boolean; activated: boolean; active: boolean }> = {}) {
    const s = { now: 10_000, focused: false, activated: false, active: true, released: 0, ...o };
    const env: GestureEnv = { now: () => s.now, focused: () => s.focused, activated: () => s.activated, active: () => s.active, release: () => void (s.released++, (s.focused = false)) };
    return { s, g: new Gesture(env) };
  }

  it("gives nothing to an action posted on load", () => {
    const { g } = gesture();
    expect(g.take()).toBe(false);
  });

  it("gives one action per press into the frame, at most one a second", () => {
    const { s, g } = gesture();
    s.focused = s.activated = true; // a click into the frame
    g.focusIn();
    expect(g.take()).toBe(true);
    expect(s.released).toBe(1); // the focus is back: the next press is a new focus-in
    expect(g.take()).toBe(false); // the same press: nothing more
    s.focused = true; // the frame takes the focus again, under the same activation
    expect(g.take()).toBe(false);
    s.now += 200;
    g.focusIn();
    expect(g.take()).toBe(false); // within the second
    s.now += 1000;
    s.focused = true;
    g.focusIn();
    expect(g.take()).toBe(true);
  });

  it("needs a real activation and the focus in the frame", () => {
    const { s, g } = gesture({ focused: true });
    g.focusIn(); // the frame focused itself, no input
    expect(g.take()).toBe(false);
    s.activated = true;
    g.focusIn();
    s.focused = false; // the person clicked elsewhere since
    expect(g.take()).toBe(false);
  });

  it("lets a press into a window that isn't selected only select it", () => {
    const { s, g } = gesture({ focused: true, activated: true, active: false });
    g.focusIn(false);
    s.active = true;
    g.activeChanged(true); // the press selected the window: the frame gives the focus back
    expect(s.released).toBe(1);
    g.focusIn(false); // the late look at the same press
    expect(g.take()).toBe(false);
  });
});

/** frame.js in a stand-in page: what it posts to the app, and a way to answer it. */
function page(init: Record<string, unknown>) {
  const code = fs.readFileSync(path.join(import.meta.dirname, "../src/package-frame/frame.js"), "utf8");
  const posted: Record<string, unknown>[] = [];
  const on: Record<string, ((e: unknown) => void)[]> = {};
  const parent = { postMessage: (m: Record<string, unknown>) => posted.push(m) };
  const win: Record<string, unknown> = { __CMD_FRAME__: init, addEventListener: (t: string, fn: (e: unknown) => void) => (on[t] ??= []).push(fn) };
  const doc = { documentElement: { dataset: {}, style: { setProperty() {} } }, addEventListener() {} };
  new Function("window", "parent", "document", "Element", "innerWidth", code)(win, parent, doc, class {}, 500);
  const cmd = win.cmd as Record<string, Record<string, (...a: unknown[]) => unknown>> & { on(t: string, fn: (v: unknown) => void, q?: unknown): () => void };
  const send = (data: unknown) => on.message?.forEach((fn) => fn({ source: parent, data }));
  return { cmd, posted, send, forged: (data: unknown) => on.message?.forEach((fn) => fn({ source: {}, data })) };
}

describe("a frame widget's page cmd", () => {
  const init = { appearance: "dark", state: { volume: 0.5 }, config: { repo: "jan/cmd" }, api: { verbs: API_VERBS, topics: API_TOPICS, major: 1, minor: 1, version: "9.9.9" } };

  it("has every verb of the registry under its name, each posted as a call with its arguments", () => {
    const { cmd, posted } = page(init);
    for (const v of API_VERBS) {
      const [ns, name] = v.split(".") as [string, string];
      if (v === "state.get" || v === "state.set") continue; // the window's state, at hand (below)
      expect(typeof cmd[ns]?.[name], v).toBe("function");
      void (cmd[ns]![name]!("a", 1) as Promise<unknown>).catch(() => {});
      expect(posted.at(-1), v).toMatchObject({ type: "call", verb: v, params: ["a", 1] });
    }
    void (cmd.run as unknown as (p: string, a: string[]) => Promise<unknown>)("gh", ["run", "list"]);
    expect(posted.at(-1)).toMatchObject({ type: "call", verb: "run.exec", params: ["gh", ["run", "list"]] });
    for (const t of API_TOPICS) expect(typeof cmd[t]?.subscribe, t).toBe("function");
    expect((cmd.env as unknown as { get(): { verbs: string[]; version: string } }).get()).toMatchObject({ version: "9.9.9", verbs: API_VERBS });
    expect((cmd.env as unknown as { has(v: string): boolean }).has("agents.start")).toBe(true);
  });

  it("resolves a call with the app's answer, rejects a refusal with its permission, and takes answers from the app only", async () => {
    const { cmd, posted, send, forged } = page(init);
    const list = cmd.agents!.list!() as Promise<unknown>;
    const id = posted.at(-1)!.id;
    forged({ type: "result", id, ok: true, value: ["forged"] });
    send({ type: "result", id, ok: true, value: [{ id: "a1" }] });
    expect(await list).toEqual([{ id: "a1" }]);
    const fetch = cmd.net!.fetch!("https://x.example/") as Promise<unknown>;
    send({ type: "result", id: posted.at(-1)!.id, ok: false, error: { code: "permission", permission: 'net: ["x.example"]', message: "needs net" } });
    await expect(fetch).rejects.toMatchObject({ name: "ApiCallError", code: "permission", permission: 'net: ["x.example"]' });
  });

  it("subscribes to a topic, gets its values, and stops it", () => {
    const { cmd, posted, send } = page(init);
    const got: unknown[] = [];
    const off = cmd.agents!.subscribe!({ scope: "all" }, (v: unknown) => got.push(v)) as () => void;
    const sub = posted.at(-1)!;
    expect(sub).toMatchObject({ type: "subscribe", topic: "agents", query: { scope: "all" } });
    send({ type: "event", sub: sub.sub, data: [1] });
    send({ type: "event", sub: sub.sub, data: [2] });
    off();
    expect(posted.at(-1)).toEqual({ type: "unsubscribe", sub: sub.sub });
    send({ type: "event", sub: sub.sub, data: [3] });
    expect(got).toEqual([[1], [2]]);
    const viaOn: unknown[] = [];
    cmd.on("events", (v) => viaOn.push(v), { types: ["note"] });
    expect(posted.at(-1)).toMatchObject({ type: "subscribe", topic: "events", query: { types: ["note"] } });
    send({ type: "event", sub: posted.at(-1)!.sub, data: [{ id: 1 }] });
    expect(viaOn).toEqual([[{ id: 1 }]]);
  });

  it("has a Frame's data at hand and on change, and posts a value to the app", () => {
    const { cmd, posted, send } = page({ ...init, data: { values: [1] } });
    expect((cmd as unknown as { data: unknown }).data).toEqual({ values: [1] });
    const got: unknown[] = [];
    cmd.on("data", (v) => got.push(v));
    send({ type: "data", data: { values: [1] } }); // the same: nothing
    send({ type: "data", data: { values: [2] } });
    expect(got).toEqual([{ values: [2] }]);
    (cmd as unknown as { post(v: unknown): void }).post({ picked: 0 });
    expect(posted.at(-1)).toEqual({ type: "post", value: { picked: 0 } });
  });

  it("keeps state, config and open as before: state at hand, config as values, open as windows.open", () => {
    const { cmd, posted } = page(init);
    const state = cmd.state as unknown as { get(k: string): unknown; set(k: string, v: unknown): Promise<null> };
    expect(state.get("volume")).toBe(0.5);
    void state.set("volume", 0.7);
    expect(posted.at(-1)).toEqual({ type: "state", key: "volume", value: 0.7 });
    expect(state.get("volume")).toBe(0.7);
    const config = cmd.config as unknown as { repo: string; get(): { repo: string } };
    expect([config.repo, config.get().repo, Object.keys(config)]).toEqual(["jan/cmd", "jan/cmd", ["repo"]]);
    void (cmd.open as unknown as (u: string) => Promise<unknown>)("https://example.com/").catch(() => {});
    expect(posted.at(-1)).toMatchObject({ type: "call", verb: "windows.open", params: ["https://example.com/"] });
  });
});
