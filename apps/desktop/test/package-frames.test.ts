// Frame widgets' pages (main/package-frames.ts): only files inside the package folder are
// served (`..`, encoded or not, a dot-file, a link out of the folder: nothing), view.html gets
// the prelude with the theme and the page's `cmd`, under a CSP without network but the grant's
// media hosts; and the one frame host's gesture rule (lib/frames.ts, AR1-11-05): an action
// with no press before it does nothing, one press gives one action, at most one a second.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
    expect(html).toContain("window.cmd = {");
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
