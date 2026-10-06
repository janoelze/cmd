import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseJsonc, parseSettingValue, resolveSettings, type Settings } from "@cmd/protocol";
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
