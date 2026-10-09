// Kit versions (docs/40-window-design.md): a widget's manifest pins the kit it was
// made with, so changing the kit never changes a widget nobody asked to change.
// Kit 1 is frozen; widgets without "kit" are on it; new ones get the current kit;
// a change to a kit-1 widget moves it up.

import crypto from "node:crypto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { CURRENT_KIT, KIT1_RENAMES } from "@cmd/protocol";
import { kitCss } from "../src/magic/host.ts";
import { lintBody } from "../src/magic/lint.ts";
import { buildRequest } from "../src/magic/prompt.ts";
import { keepKit } from "../src/magic/widget-tools.ts";
import { parseManifest } from "../src/widgets/manifest.ts";
import type { VerifyContext } from "../src/widgets/verify.ts";

const manifest = (extra: object) => parseManifest({ cmd: 2, kind: "widget", title: "T", size: "m", refresh: 0, ...extra });

describe("kits", () => {
  it("a manifest without kit is on kit 1; a known kit is kept; an unknown one is an error", () => {
    expect(manifest({})).toMatchObject({ ok: true, manifest: { kit: 1 } });
    expect(manifest({ kit: 2 })).toMatchObject({ ok: true, manifest: { kit: 2 } });
    expect(manifest({ kit: 9 }).ok).toBe(false);
  });

  it("kit 1 is frozen: widgets made with it depend on how it looks", () => {
    const text = fs.readFileSync(new URL("../src/magic/prompt/kits/1.css", import.meta.url));
    expect(crypto.createHash("sha256").update(text).digest("hex")).toBe("ed8d21857c96c876949fcbdb7a4f9898e03730ad13387c438573c2095fc70b86");
  });

  it("each kit loads its own CSS: kit 1 its old names, the current kit the app's tokens", () => {
    expect(kitCss(1)).toContain("--line: color-mix");
    expect(kitCss(1)).not.toContain("--space-md");
    expect(kitCss(CURRENT_KIT)).toContain("--space-md:");
    expect(kitCss(CURRENT_KIT)).toContain(".k-toolbar");
    expect(kitCss(CURRENT_KIT)).not.toMatch(/--line:/);
  });

  it("a manifest written without kit keeps the widget's; a new widget gets the current kit", () => {
    const ctx = (before: string | null) => ({ id: "w", store: { read: () => before } }) as unknown as VerifyContext;
    const written = JSON.stringify({ cmd: 2, title: "T" });
    expect(JSON.parse(keepKit(ctx(null), "manifest.json", written)).kit).toBe(CURRENT_KIT);
    expect(JSON.parse(keepKit(ctx(JSON.stringify({ title: "old" })), "manifest.json", written)).kit).toBe(1);
    expect(JSON.parse(keepKit(ctx(JSON.stringify({ kit: 2 })), "manifest.json", written)).kit).toBe(2);
    expect(keepKit(ctx(null), "manifest.json", JSON.stringify({ kit: 1 }))).toBe(JSON.stringify({ kit: 1 }));
    expect(keepKit(ctx(null), "view.html", "<div></div>")).toBe("<div></div>");
  });

  it("changing a kit-1 widget asks to move it to the current kit", () => {
    const req = (manifestJson: string) => buildRequest("Make it blue", { cwd: "/tmp", explore: false, files: { "manifest.json": manifestJson, "view.html": "<div></div>" } });
    expect(req(JSON.stringify({ title: "T" }))).toContain(`"kit": ${CURRENT_KIT}`);
    expect(req(JSON.stringify({ title: "T" }))).toContain("--line → --separator");
    expect(req(JSON.stringify({ title: "T", kit: CURRENT_KIT }))).not.toContain("kit 1");
  });

  it("the lint names kit 1's variables only in widgets on a later kit", () => {
    const body = `<style>.a{color:var(--good)}</style><script>getComputedStyle(document.documentElement).getPropertyValue("--c1")</script>`;
    expect(lintBody(body, 1).oldTokens).toEqual([]);
    expect(lintBody(body, 2).oldTokens).toEqual([
      ["--good", KIT1_RENAMES["--good"]],
      ["--c1", KIT1_RENAMES["--c1"]],
    ]);
  });
});
