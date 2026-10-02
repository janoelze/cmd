import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, parseJsonc, parseSettingValue, resolveSettings } from "@cmd/protocol";
import { SettingsService } from "../src/settings.ts";
import { launchCommand } from "../src/agents/tracker.ts";

describe("schema", () => {
  it("overlays valid user values and reports invalid ones", () => {
    const { settings, errors } = resolveSettings({
      "terminal.fontSize": 15,
      "terminal.lineHeight": 9,
      "ui.defaultView": "grid",
      "nope.key": 1,
      "plugins.vpn.conf": "x",
    });
    expect(settings["terminal.fontSize"]).toBe(15);
    expect(settings["terminal.lineHeight"]).toBe(DEFAULT_SETTINGS["terminal.lineHeight"]);
    expect(settings["ui.defaultView"]).toBe("grid");
    expect(errors).toEqual(["terminal.lineHeight: must be ≤ 2", 'unknown setting "nope.key"']);
  });

  it("parses JSONC with comments and trailing commas", () => {
    expect(parseJsonc('// hi\n{ "a": "x // not a comment", /* b */ "b": [1,2,], }')).toEqual({
      a: "x // not a comment",
      b: [1, 2],
    });
  });

  it("coerces CLI strings by type", () => {
    expect(parseSettingValue("terminal.fontSize", "14")).toBe(14);
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
    svc.set("terminal.fontSize", 16);
    expect(parseJsonc(fs.readFileSync(file, "utf8"))).toEqual({ "terminal.fontSize": 16 });
    expect(svc.snapshot().overrides).toEqual(["terminal.fontSize"]);
    expect(() => svc!.set("terminal.fontSize", "big")).toThrow(/expected a number/);
    svc.reset("terminal.fontSize");
    expect(svc.settings["terminal.fontSize"]).toBe(DEFAULT_SETTINGS["terminal.fontSize"]);
  });

  it("picks up edits made to the file by hand", async () => {
    svc = new SettingsService(file);
    svc.watch();
    const updated = new Promise((r) => svc!.once("updated", r));
    fs.writeFileSync(file, '// mine\n{ "ui.sidebarWidth": 320 }');
    await updated;
    expect(svc.settings["ui.sidebarWidth"]).toBe(320);
  });
});
