import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { allowedAppUrl } from "../src/shared/app-url.ts";

const rendererDir = "/Applications/cmd dev.app/Contents/Resources/app.asar/out/renderer";
const built = { rendererDir };
const dev = { rendererDir, devUrl: "http://localhost:5173" };
const page = (name: string) => pathToFileURL(path.join(rendererDir, name)).href;

describe("allowedAppUrl", () => {
  it("allows the app's built pages, with a query or hash", () => {
    expect(allowedAppUrl(page("index.html"), built)).toBe(true);
    expect(allowedAppUrl(`${page("index.html")}?workspace=home`, built)).toBe(true);
    expect(allowedAppUrl(`${page("settings.html")}?page=remote#x`, built)).toBe(true);
    expect(allowedAppUrl(page("workbench.html"), built)).toBe(true);
  });

  it("allows the dev server in pnpm dev, and only then", () => {
    expect(allowedAppUrl("http://localhost:5173/?workspace=home", dev)).toBe(true);
    expect(allowedAppUrl("http://localhost:5173/settings.html?page=remote", dev)).toBe(true);
    expect(allowedAppUrl("http://localhost:5173/", built)).toBe(false);
    expect(allowedAppUrl("http://localhost:5174/", dev)).toBe(false);
    expect(allowedAppUrl("http://127.0.0.1:5173/", dev)).toBe(false);
  });

  it("refuses the web", () => {
    for (const opts of [built, dev]) {
      expect(allowedAppUrl("https://example.com/", opts)).toBe(false);
      expect(allowedAppUrl("http://example.com/index.html", opts)).toBe(false);
    }
  });

  it("refuses files anywhere else", () => {
    expect(allowedAppUrl("file:///tmp/index.html", built)).toBe(false);
    expect(allowedAppUrl(pathToFileURL(path.join(rendererDir, "assets", "x.html")).href, built)).toBe(false);
    expect(allowedAppUrl(pathToFileURL(path.join(rendererDir, "..", "evil.html")).href, built)).toBe(false);
    expect(allowedAppUrl(`${page("..")}/evil.html`, built)).toBe(false);
    expect(allowedAppUrl(page("notes.txt"), built)).toBe(false);
    expect(allowedAppUrl("file://host/Applications/cmd%20dev.app/Contents/Resources/app.asar/out/renderer/index.html", built)).toBe(false);
    expect(allowedAppUrl(`${pathToFileURL(rendererDir).href}/a%2Fb.html`, built)).toBe(false);
  });

  it("refuses other schemes", () => {
    for (const u of ["javascript:alert(1)", "data:text/html,<p>x</p>", "about:blank", "cmd-widget://frame/", "not a url", ""]) expect(allowedAppUrl(u, dev)).toBe(false);
  });
});
