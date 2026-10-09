import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEYBINDINGS_TEMPLATE, keybindingsPath, loadKeybindings, writeKeybinding } from "../src/main/keybindings.ts";

describe("keybindings.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-keys-"));
  const saved = process.env.CMD_CONFIG_DIR;
  beforeAll(() => void (process.env.CMD_CONFIG_DIR = dir));
  afterAll(() => {
    if (saved === undefined) delete process.env.CMD_CONFIG_DIR;
    else process.env.CMD_CONFIG_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("changes only the shortcut it writes, keeping comments", () => {
    const before = '// mine\n{\n  // for setup\n  "app.setup": "Alt+Cmd+U", // muscle memory\n}\n';
    fs.writeFileSync(keybindingsPath(), before);
    writeKeybinding("app.taskManager", ["Alt+Cmd+J", "Ctrl+Alt+J"]);
    expect(fs.readFileSync(keybindingsPath(), "utf8")).toBe(before.replace("memory\n", 'memory\n  "app.taskManager": ["Alt+Cmd+J", "Ctrl+Alt+J"],\n'));
    expect(loadKeybindings().bindings["app.taskManager"]).toEqual(["Alt+Cmd+J", "Ctrl+Alt+J"]);
    writeKeybinding("app.taskManager", null);
    expect(fs.readFileSync(keybindingsPath(), "utf8")).toBe(before);
  });

  it("starts a missing file from the template", () => {
    fs.rmSync(keybindingsPath());
    writeKeybinding("app.setup", ["Alt+Cmd+U"]);
    expect(fs.readFileSync(keybindingsPath(), "utf8")).toBe(KEYBINDINGS_TEMPLATE.replace("{\n", '{\n  "app.setup": ["Alt+Cmd+U"]\n'));
  });

  it("never writes over a file that doesn't parse", () => {
    const broken = '{\n  "app.setup": "Alt+Cmd+U"\n  "app.taskManager": "Alt+Cmd+J"\n}\n';
    fs.writeFileSync(keybindingsPath(), broken);
    expect(() => writeKeybinding("app.setup", null)).toThrow("keybindings.json: expected a comma at line 3, column 3. Fix it first.");
    expect(fs.readFileSync(keybindingsPath(), "utf8")).toBe(broken);
  });
});
