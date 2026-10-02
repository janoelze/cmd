import { describe, expect, it } from "vitest";
import { COMMANDS, DEFAULT_KEYBINDINGS, prettyAccelerator, resolveKeybindings } from "../src/shared/commands.ts";

describe("commands", () => {
  it("has unique ids and no conflicting default shortcuts", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const all = Object.values(DEFAULT_KEYBINDINGS).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("binds HIG defaults and ⌥⌘←/→ for sessions", () => {
    expect(DEFAULT_KEYBINDINGS["file.newTerminal"]).toEqual(["Cmd+N", "Cmd+T"]);
    expect(DEFAULT_KEYBINDINGS["file.close"]).toEqual(["Cmd+W"]);
    expect(DEFAULT_KEYBINDINGS["session.next"]?.[0]).toBe("Alt+Cmd+Right");
    expect(DEFAULT_KEYBINDINGS["session.prev"]?.[0]).toBe("Alt+Cmd+Left");
  });
});

describe("resolveKeybindings", () => {
  it("replaces, adds, unbinds and reports unknown commands", () => {
    const { bindings, errors } = resolveKeybindings({
      "session.next": ["Ctrl+Tab", "Alt+Cmd+Right"],
      "edit.clear": null,
      "file.newClaude": "Shift+Cmd+N",
      "nope.cmd": "Cmd+X",
      "view.grid": 42,
    });
    expect(bindings["session.next"]).toEqual(["Ctrl+Tab", "Alt+Cmd+Right"]);
    expect(bindings["edit.clear"]).toEqual([]);
    expect(bindings["file.newClaude"]).toEqual(["Shift+Cmd+N"]);
    expect(errors).toEqual(['unknown command "nope.cmd"', "view.grid: expected a shortcut string, a list of them, or null"]);
  });

  it("steals a shortcut from the command that had it by default", () => {
    const { bindings } = resolveKeybindings({ "view.palette": "Cmd+Shift+P", "file.newClaude": "Command+N" });
    expect(bindings["file.newTerminal"]).toEqual(["Cmd+T"]);
    expect(bindings["file.newClaude"]).toEqual(["Command+N"]);
  });
});

describe("prettyAccelerator", () => {
  it("renders macOS symbols in canonical order", () => {
    expect(prettyAccelerator("Cmd+Alt+Right")).toBe("⌥⌘→");
    expect(prettyAccelerator("Shift+Cmd+[")).toBe("⇧⌘[");
    expect(prettyAccelerator("Ctrl+Cmd+J")).toBe("⌃⌘J");
  });
});
