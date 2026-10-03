import { describe, expect, it } from "vitest";
import { COMMANDS, otherPlatformKey, platformDefaults, prettyAccelerator, resolveKeybindings } from "../src/shared/commands.ts";

// Both keymaps are tested on every platform.
const MAC = platformDefaults(true);
const OTHER = platformDefaults(false);

describe("commands", () => {
  it("has unique ids and no conflicting default shortcuts", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const keymap of [MAC, OTHER]) {
      const all = Object.values(keymap).flat();
      expect(new Set(all).size).toBe(all.length);
    }
  });

  it("binds HIG defaults and ⌥⌘←/→ for sessions", () => {
    expect(MAC["file.newTerminal"]).toEqual(["Cmd+N", "Cmd+T"]);
    expect(MAC["file.close"]).toEqual(["Cmd+W"]);
    expect(MAC["session.next"]?.[0]).toBe("Alt+Cmd+Right");
    expect(MAC["session.prev"]?.[0]).toBe("Alt+Cmd+Left");
  });

  it("maps the macOS keymap to Windows Terminal style elsewhere", () => {
    expect(otherPlatformKey("Cmd+N")).toBe("Ctrl+Shift+N");
    expect(otherPlatformKey("Alt+Cmd+N")).toBe("Ctrl+Alt+N");
    expect(otherPlatformKey("Shift+Cmd+B")).toBe("Ctrl+Alt+Shift+B");
    expect(otherPlatformKey("Ctrl+Cmd+J")).toBe("Ctrl+Alt+Shift+J");
    expect(otherPlatformKey("Cmd+,")).toBe("Ctrl+,");
    expect(otherPlatformKey("Cmd+=")).toBe("Ctrl+=");
    expect(otherPlatformKey("Ctrl+3")).toBe("Ctrl+3");
    expect(OTHER["file.newTerminal"]).toEqual(["Ctrl+Shift+N", "Ctrl+Shift+T"]);
    expect(OTHER["view.palette"]).toEqual(["Ctrl+Shift+K"]);
    // No plain Ctrl+letter: those belong to the shell.
    expect(Object.values(OTHER).flat().filter((k) => /^Ctrl\+[A-Z]$/.test(k))).toEqual([]);
    // ⇧⌘] and ⌃⌘] meet at Ctrl+Alt+Shift+]: Next Space keeps it, Next Session keeps Ctrl+Alt+Right.
    expect(OTHER["space.next"]).toEqual(["Ctrl+Alt+Shift+]"]);
    expect(OTHER["session.next"]).toEqual(["Ctrl+Alt+Right"]);
  });
});

describe("resolveKeybindings", () => {
  it("replaces, adds, unbinds and reports unknown commands", () => {
    const { bindings, errors } = resolveKeybindings(
      {
        "session.next": ["Ctrl+Tab", "Alt+Cmd+Right"],
        "edit.clear": null,
        "file.newClaude": "Shift+Cmd+N",
        "nope.cmd": "Cmd+X",
        "view.grid": 42,
      },
      MAC,
    );
    expect(bindings["session.next"]).toEqual(["Ctrl+Tab", "Alt+Cmd+Right"]);
    expect(bindings["edit.clear"]).toEqual([]);
    expect(bindings["file.newClaude"]).toEqual(["Shift+Cmd+N"]);
    expect(errors).toEqual(['unknown command "nope.cmd"', "view.grid: expected a shortcut string, a list of them, or null"]);
  });

  it("steals a shortcut from the command that had it by default", () => {
    const { bindings } = resolveKeybindings({ "view.palette": "Cmd+Shift+P", "file.newClaude": "Command+N" }, MAC);
    expect(bindings["file.newTerminal"]).toEqual(["Cmd+T"]);
    expect(bindings["file.newClaude"]).toEqual(["Command+N"]);
  });
});

describe("prettyAccelerator", () => {
  it("renders macOS symbols in canonical order", () => {
    expect(prettyAccelerator("Cmd+Alt+Right", true)).toBe("⌥⌘→");
    expect(prettyAccelerator("Shift+Cmd+[", true)).toBe("⇧⌘[");
    expect(prettyAccelerator("Ctrl+Cmd+J", true)).toBe("⌃⌘J");
    expect(prettyAccelerator("Ctrl+Alt+Shift+k", false)).toBe("Ctrl+Alt+Shift+K");
  });
});
