import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, editJsonc, parseJsonc, parseSettingValue, resolveSettings, SETTINGS_TEMPLATE, type Settings } from "@cmd/protocol";
import { Core } from "../src/core.ts";
import { SettingsService } from "../src/settings.ts";
import { fakeFactory } from "./fake-pty.ts";
import { launchCommand } from "../src/agents/tracker.ts";
import { rmTemp } from "./tmp.ts";

describe("schema", () => {
  it("overlays valid user values and reports invalid ones", () => {
    const { settings, errors } = resolveSettings({
      "font.codeSize": 15,
      "terminal.lineHeight": 9,
      "ui.defaultView": "grid",
      "nope.key": 1,
      "plugins.vpn.conf": "x",
    });
    expect(settings["font.codeSize"]).toBe(15);
    expect(settings["terminal.lineHeight"]).toBe(DEFAULT_SETTINGS["terminal.lineHeight"]);
    expect(settings["ui.defaultView"]).toBe("grid");
    expect(errors).toEqual(["terminal.lineHeight: must be ≤ 2", 'unknown setting "nope.key"']);
  });

  it("reads renamed keys under their new name; the new name wins", () => {
    expect(resolveSettings({ "terminal.fontSize": 17 }).settings["font.codeSize"]).toBe(17);
    expect(resolveSettings({ "terminal.fontSize": 17, "font.codeSize": 12 }).settings["font.codeSize"]).toBe(12);
    expect(resolveSettings({ "terminal.fontFamily": "Iosevka" })).toMatchObject({ settings: { "font.code": "Iosevka" }, errors: [] });
    expect(resolveSettings({ "ui.sidebarWidth": 320 }).errors).toEqual([]); // removed: no error
  });

  it("parses JSONC with comments and trailing commas", () => {
    expect(parseJsonc('// hi\n{ "a": "x // not a comment", /* b */ "b": [1,2,], }')).toEqual({
      a: "x // not a comment",
      b: [1, 2],
    });
  });

  it("leaves strings alone when it drops trailing commas, and says where a file breaks", () => {
    expect(parseJsonc('{ "data.exclude": "a, ]b" , }')).toEqual({ "data.exclude": "a, ]b" });
    expect(parseJsonc('{ "a": "x, }" , "b": [", ]",], }')).toEqual({ a: "x, }", b: [", ]"] });
    expect(() => parseJsonc('{\n  "a": 1\n  "b": 2\n}')).toThrow("expected a comma at line 3, column 3");
  });

  it("edits JSONC one key at a time, keeping everything else", () => {
    const text = '// top\n{\n  // keep me\n  "a": [1, 2], /* and me */\n  "b": "x",\n}\n';
    expect(editJsonc(text, { b: "y" })).toBe('// top\n{\n  // keep me\n  "a": [1, 2], /* and me */\n  "b": "y",\n}\n');
    expect(editJsonc(text, { c: ["Cmd+K", "Ctrl+K"] })).toBe('// top\n{\n  // keep me\n  "a": [1, 2], /* and me */\n  "b": "x",\n  "c": ["Cmd+K", "Ctrl+K"],\n}\n');
    expect(parseJsonc(editJsonc(text, { a: undefined, gone: undefined }))).toEqual({ b: "x" });
    expect(editJsonc("", { a: 1 }, "// hi\n{\n}\n")).toBe('// hi\n{\n  "a": 1\n}\n');
    // A comment at the end of the last key's line stays on that line, with or without trailing commas.
    const plain = '{\n  "a": 1, // one\n  "b": 2 // two\n}\n';
    expect(editJsonc(plain, { c: 3 })).toBe('{\n  "a": 1, // one\n  "b": 2, // two\n  "c": 3\n}\n');
    expect(editJsonc(editJsonc(plain, { c: 3 }), { c: undefined })).toBe(plain);
    expect(editJsonc(plain, { b: undefined })).toBe('{\n  "a": 1 // one\n}\n');
    expect(editJsonc(plain.replaceAll("\n", "\r\n"), { c: 3 })).toBe(editJsonc(plain, { c: 3 }).replaceAll("\n", "\r\n"));
    expect(parseJsonc(editJsonc('{ "a": 1 }', { b: 2 }))).toEqual({ a: 1, b: 2 }); // one line: modify() lays it out
  });

  it("coerces CLI strings by type", () => {
    expect(parseSettingValue("font.codeSize", "14")).toBe(14);
    expect(parseSettingValue("notifications.done", "false")).toBe(false);
    expect(parseSettingValue("shell.program", "/bin/bash")).toBe("/bin/bash");
  });

  it("uses the configured agent command", () => {
    const s = { ...DEFAULT_SETTINGS, "agents.claude.command": "claude --model opus" };
    expect(launchCommand("claude", undefined, s).command).toMatch(/^claude --model opus --session-id /);
  });
});

describe("SettingsService", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-settings-"));
  const file = path.join(dir, "settings.json");
  let svc: SettingsService | null = null;
  afterEach(() => {
    svc?.close();
    fs.rmSync(file, { force: true });
  });

  it("starts from defaults when the file is missing", () => {
    svc = new SettingsService(file);
    expect(svc.snapshot()).toMatchObject({ settings: DEFAULT_SETTINGS, overrides: [], errors: [] });
  });

  it("writes, resets and rejects invalid values", () => {
    svc = new SettingsService(file);
    svc.set("font.codeSize", 16);
    expect(parseJsonc(fs.readFileSync(file, "utf8"))).toEqual({ "font.codeSize": 16 });
    expect(svc.snapshot().overrides).toEqual(["font.codeSize"]);
    expect(() => svc!.set("font.codeSize", "big")).toThrow(/expected a number/);
    svc.reset("font.codeSize");
    expect(svc.settings["font.codeSize"]).toBe(DEFAULT_SETTINGS["font.codeSize"]);
  });

  it("moves an old key name to the new one when it's set or reset", () => {
    fs.writeFileSync(file, '{ "terminal.fontSize": 17, "terminal.fontFamily": "Iosevka" }');
    svc = new SettingsService(file);
    expect(svc.snapshot().overrides.sort()).toEqual(["font.code", "font.codeSize"]);
    svc.set("terminal.fontSize", 18); // old names are accepted
    expect(parseJsonc(fs.readFileSync(file, "utf8"))).toEqual({ "font.codeSize": 18, "terminal.fontFamily": "Iosevka" });
    svc.reset("font.code");
    expect(parseJsonc(fs.readFileSync(file, "utf8"))).toEqual({ "font.codeSize": 18 });
  });

  it("changes only the key it sets: comments, order and trailing commas stay", () => {
    const before = '// mine\n{\n  // big text\n  "font.codeSize": 16, // really\n  /* cursor */\n  "terminal.cursorStyle": "bar",\n}\n';
    fs.writeFileSync(file, before);
    svc = new SettingsService(file);
    svc.set("ui.gutter", 12);
    expect(fs.readFileSync(file, "utf8")).toBe(before.replace('"bar",\n', '"bar",\n  "ui.gutter": 12,\n'));
    svc.set("font.codeSize", 18);
    expect(fs.readFileSync(file, "utf8")).toBe(before.replace("16", "18").replace('"bar",\n', '"bar",\n  "ui.gutter": 12,\n'));
    svc.reset("ui.gutter");
    expect(fs.readFileSync(file, "utf8")).toBe(before.replace("16", "18"));
  });

  it("starts a missing or blank file from the template", () => {
    svc = new SettingsService(file);
    svc.set("ui.gutter", 12);
    expect(fs.readFileSync(file, "utf8")).toBe(SETTINGS_TEMPLATE.replace("{\n}", '{\n  "ui.gutter": 12\n}'));
    fs.writeFileSync(file, "  \n");
    svc.reload();
    expect(svc.snapshot().errors).toEqual([]);
    svc.set("ui.gutter", 14);
    expect(parseJsonc(fs.readFileSync(file, "utf8"))).toEqual({ "ui.gutter": 14 });
  });

  it("keeps the last good settings while the file doesn't parse", () => {
    fs.writeFileSync(file, '{\n  "font.codeSize": 16,\n  "terminal.cursorStyle": "bar"\n}\n');
    svc = new SettingsService(file);
    fs.writeFileSync(file, '{\n  "font.codeSize": 17\n  "terminal.cursorStyle": "bar"\n}\n'); // a comma missing
    svc.reload();
    expect(svc.settings["font.codeSize"]).toBe(16);
    expect(svc.settings["terminal.cursorStyle"]).toBe("bar");
    expect(svc.snapshot().overrides.sort()).toEqual(["font.codeSize", "terminal.cursorStyle"]);
    expect(svc.snapshot().errors).toEqual(["settings.json: expected a comma at line 3, column 3. Settings stay as they were until it's fixed."]);
    fs.writeFileSync(file, '{ "font.codeSize": 17 }');
    svc.reload();
    expect(svc.snapshot()).toMatchObject({ errors: [], overrides: ["font.codeSize"], settings: { "font.codeSize": 17, "terminal.cursorStyle": DEFAULT_SETTINGS["terminal.cursorStyle"] } });
  });

  it("never writes over a file that doesn't parse", () => {
    fs.writeFileSync(file, '// my notes\n{\n  "font.codeSize": 16,\n  "shell.program": "/bin/zsh"\n}\n');
    svc = new SettingsService(file);
    const broken = '// my notes\n{\n  "font.codeSize": 16\n  "shell.program": "/bin/zsh"\n}\n';
    fs.writeFileSync(file, broken); // not reloaded yet: set reads the file as it is now
    expect(() => svc!.set("ui.gutter", 12)).toThrow("settings.json: expected a comma at line 4, column 3. Fix it first.");
    expect(() => svc!.reset("font.codeSize")).toThrow(/Fix it first/);
    expect(fs.readFileSync(file, "utf8")).toBe(broken);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(svc.snapshot().errors).toHaveLength(1);
    expect(svc.settings["font.codeSize"]).toBe(16);
    fs.writeFileSync(file, "[]"); // parses, but isn't settings
    expect(() => svc!.set("ui.gutter", 12)).toThrow("settings.json: expected an object in { }. Fix it first.");
    expect(fs.readFileSync(file, "utf8")).toBe("[]");
  });

  it("picks up edits made to the file by hand", async () => {
    svc = new SettingsService(file);
    svc.watch();
    const updated = new Promise((r) => svc!.once("updated", r));
    fs.writeFileSync(file, '// mine\n{ "ui.gutter": 20 }');
    await updated;
    expect(svc.settings["ui.gutter"]).toBe(20);
  });
});

describe("live apply", () => {
  it("bind runs now and only when one of its keys changes", () => {
    const svc = new SettingsService(null);
    const seen: number[] = [];
    const off = svc.bind(["font.codeSize"], (s) => seen.push(s["font.codeSize"]));
    svc.set("ui.gutter", 12);
    svc.set("font.codeSize", 16);
    off();
    svc.set("font.codeSize", 18);
    expect(seen).toEqual([DEFAULT_SETTINGS["font.codeSize"], 16]);
  });

  it("reads transcripts again when their settings change, one reader at a time, none when they're off", async () => {
    const made: Settings[] = [];
    const core = new Core({ socketPath: "", dbPath: null, terminals: fakeFactory().factory, pollMs: 0, ingestInline: true, transcriptRoots: (s) => (made.push(s), []) });
    core.start(); // the reader starts as a startup job (listen() would run it)
    await core.scheduler.idle();
    const settle = () => new Promise((r) => setTimeout(r, 0));
    await settle();
    await core.call("settings.set", { key: "search.archiveDirs", value: "~/a, ~/b" });
    await settle();
    await core.call("settings.set", { key: "font.codeSize", value: 15 }); // not transcripts: no restart
    await settle();
    // Changes in a burst start one reader, with the latest settings; off means none.
    await core.call("settings.set", { key: "search.archiveDirs", value: "~/c" });
    await core.call("settings.set", { key: "data.record.transcripts", value: false });
    await settle();
    expect(made.map((s) => s["search.archiveDirs"])).toEqual([DEFAULT_SETTINGS["search.archiveDirs"], "~/a, ~/b"]);
    await expect(core.call("search.reindex", {})).rejects.toThrow(/off/);
    await core.close();
  });

  it.skipIf(!fs.existsSync("/bin/zsh"))("keeps the shell `open` rules file current for running shells", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-rules-"));
    const rules = path.join(dir, "shell-open.zsh");
    const { factory, ptys } = fakeFactory();
    const core = new Core({ socketPath: "", dbPath: null, terminals: factory, pollMs: 0, shellRulesFile: rules });
    const read = (name: string) => execFileSync("/bin/zsh", ["-fc", `source ${rules}; print -r -- $${name}`], { encoding: "utf8" }).trim();
    expect(read("CMD_OPEN_URLS")).toBe("0");
    await core.call("settings.set", { key: "shell.openUrls", value: true });
    expect(read("CMD_OPEN_URLS")).toBe("1");
    // User text is quoted, not run.
    await core.call("settings.set", { key: "open.handlers", value: "it's$(touch${IFS}pwned): text" });
    expect(read("CMD_OPEN_EXTS").split(" ")).toContain("it's$(touch${ifs}pwned)"); // lowercased
    expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
    await core.call("settings.set", { key: "shell.program", value: "/bin/zsh" });
    core.panes.create();
    expect(ptys[0]!.opts.env.CMD_OPEN_RULES).toBe(rules);
    await core.close();
    rmTemp(dir);
  });
});
