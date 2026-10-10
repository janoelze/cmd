import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { classify, confirmText, linkInFile, openPolicy, type FileInfo } from "../src/main/open-policy.ts";

// What cmd hands to other apps (main/open-policy.ts): web and mail links open,
// other schemes and launchers from text on screen are asked about, javascript: never opens.

const file = (real: string, mode = 0o644): FileInfo => ({ dir: false, mode, real });
const bundle = (real: string): FileInfo => ({ dir: true, mode: 0o755, real });

describe("openPolicy", () => {
  it("opens web and mail links without asking, whoever asks", () => {
    for (const url of ["http://example.com", "https://github.com/x", "HTTPS://EXAMPLE.COM", "mailto:a@b.c"]) {
      expect(openPolicy(url, "content")).toBe("allow");
      expect(openPolicy(url, "user")).toBe("allow");
    }
  });

  it("asks before other schemes from content, opens them from a menu", () => {
    for (const url of ["smb://host/share", "x-apple.systempreferences:com.apple.preference.security", "vscode://file/x", "ssh://host"]) {
      expect(openPolicy(url, "content")).toBe("ask");
      expect(openPolicy(url, "user")).toBe("allow");
    }
  });

  it("never opens javascript:, vbscript:, data: or blob:, not even from a menu", () => {
    for (const url of ["javascript:alert(1)", "JavaScript:alert(1)", "vbscript:x", "data:text/html,<b>", "blob:https://x/1"]) {
      expect(openPolicy(url, "content")).toBe("deny");
      expect(openPolicy(url, "user")).toBe("deny");
    }
  });

  it("asks before launchers from content: scripts, apps, installers, link files", () => {
    expect(openPolicy("/tmp/deploy.command", "content", file("/tmp/deploy.command"))).toBe("ask");
    expect(openPolicy("/Applications/Calculator.app", "content", bundle("/Applications/Calculator.app"))).toBe("ask");
    expect(openPolicy("/Applications/Calculator.app/", "content", bundle("/Applications/Calculator.app"))).toBe("ask");
    for (const ext of ["tool", "terminal", "webloc", "inetloc", "fileloc", "pkg", "dmg", "scpt", "workflow"]) expect(openPolicy(`/tmp/x.${ext.toUpperCase()}`, "content", null)).toBe("ask");
    expect(openPolicy("file:///tmp/deploy.command", "content", null)).toBe("ask");
  });

  it("asks before a program by its x bits, and a link to a launcher by its real name", () => {
    expect(openPolicy("/tmp/run", "content", file("/tmp/run", 0o755))).toBe("ask");
    expect(openPolicy("/tmp/notes.txt", "content", file("/tmp/x.command"))).toBe("ask");
    expect(openPolicy("/tmp/folder", "content", bundle("/tmp/folder"))).toBe("allow");
  });

  it("opens plain files from content, and anything from a menu", () => {
    expect(openPolicy("/tmp/notes.txt", "content", file("/tmp/notes.txt"))).toBe("allow");
    expect(openPolicy("/tmp/missing.txt", "content", null)).toBe("allow");
    expect(openPolicy("/tmp/deploy.command", "user", file("/tmp/deploy.command"))).toBe("allow");
    expect(openPolicy("/Applications/Calculator.app", "user", bundle("/Applications/Calculator.app"))).toBe("allow");
    expect(openPolicy("/tmp/run", "user", file("/tmp/run", 0o755))).toBe("allow");
    expect(openPolicy("/tmp/notes.txt", "user", file("/tmp/notes.txt"))).toBe("allow");
  });

  it("reads the file's mode from disk when not told", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "open-policy-"));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
    const plain = path.join(dir, "notes.txt");
    const prog = path.join(dir, "run");
    fs.writeFileSync(plain, "hi");
    fs.writeFileSync(prog, "#!/bin/sh\n", { mode: 0o755 });
    expect(openPolicy(plain, "content")).toBe("allow");
    expect(openPolicy(prog, "content")).toBe("ask");
    const link = path.join(dir, "readme.txt");
    fs.symlinkSync(path.join(dir, "x.command"), link);
    fs.writeFileSync(path.join(dir, "x.command"), "echo hi");
    expect(openPolicy(link, "content")).toBe("ask");
    const webloc = path.join(dir, "a.webloc");
    fs.writeFileSync(webloc, `<?xml version="1.0"?><plist><dict><key>URL</key><string>smb://host/share</string></dict></plist>`);
    expect(linkInFile(webloc)).toBe("smb://host/share");
  });
});

describe("the confirmation names the real target", () => {
  it("a URL, with the app that opens it", () => {
    const c = confirmText(classify("smb://host/share"), { appName: "Finder" });
    expect(c.message).toBe("Open smb://host/share in Finder?");
    expect(c.button).toBe("Open in Finder");
    expect(confirmText(classify("weird://x")).message).toBe("Open weird://x?");
  });

  it("a script in Terminal, an app, a link file's link", () => {
    expect(confirmText(classify("/tmp/deploy.command", null)).message).toBe("Open “deploy.command” in Terminal?");
    expect(confirmText(classify("/tmp/readme.txt", file("/tmp/x.command")), { real: "/tmp/x.command" }).message).toBe("Open “x.command” in Terminal?");
    expect(confirmText(classify("/Applications/Calculator.app", null)).message).toBe("Open the app “Calculator”?");
    expect(confirmText(classify("/tmp/a.webloc", null), { link: "smb://host/share" }).message).toBe("Open smb://host/share?");
  });
});
