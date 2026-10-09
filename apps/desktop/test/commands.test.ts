import { describe, expect, it } from "vitest";
import { COMMANDS, editKeybindings, otherPlatformKey, platformDefaults, prettyAccelerator, resolveKeybindings } from "../src/shared/commands.ts";

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
    expect(MAC["file.new"]).toEqual(["Cmd+N"]);
    expect(MAC["file.newTerminal"]).toEqual(["Cmd+T"]);
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
    expect(OTHER["file.new"]).toEqual(["Ctrl+Shift+N"]);
    expect(OTHER["file.newTerminal"]).toEqual(["Ctrl+Shift+T"]);
    expect(OTHER["view.palette"]).toEqual(["Ctrl+Shift+K"]);
    // No plain Ctrl+letter: those belong to the shell.
    expect(Object.values(OTHER).flat().filter((k) => /^Ctrl\+[A-Z]$/.test(k))).toEqual([]);
    // ⇧⌘] and ⌃⌘] meet at Ctrl+Alt+Shift+]: Next Workspace keeps it, Next Session keeps Ctrl+Alt+Right.
    expect(OTHER["workspace.next"]).toEqual(["Ctrl+Alt+Shift+]"]);
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

  it("reads the space.* ids from before workspaces, and drops them when the Settings window rebinds", () => {
    const { bindings, errors } = resolveKeybindings({ "space.last": "Ctrl+Cmd+L" }, MAC);
    expect(errors).toEqual([]);
    expect(bindings["workspace.last"]).toEqual(["Ctrl+Cmd+L"]);
    expect(editKeybindings({ "space.last": "Ctrl+Cmd+L" }, "workspace.last", ["Ctrl+Cmd+K"], MAC)).toEqual({ "workspace.last": ["Ctrl+Cmd+K"] });
  });
});

describe("prettyAccelerator", () => {
  it("renders macOS symbols in canonical order", () => {
    expect(prettyAccelerator("Cmd+Alt+Right", true)).toBe("⌥⌘→");
    expect(prettyAccelerator("Shift+Cmd+[", true)).toBe("⇧⌘[");
    expect(prettyAccelerator("Ctrl+Cmd+J", true)).toBe("⌃⌘J");
    expect(prettyAccelerator("Ctrl+Alt+Shift+k", false)).toBe("Ctrl+Alt+Shift+K");
  });

  it("edits keybindings.json from the Settings window", () => {
    // A new shortcut is written; one taken from another command's entry leaves it.
    let user = editKeybindings({ "view.palette": ["Cmd+P"] }, "session.next", ["Alt+Cmd+Right", "Cmd+P"], MAC);
    expect(user).toEqual({ "view.palette": [], "session.next": ["Alt+Cmd+Right", "Cmd+P"] });
    expect(resolveKeybindings(user, MAC).bindings["view.palette"]).toEqual([]);
    // Taking a default moves it without touching the file's other entries.
    user = editKeybindings({}, "session.next", ["Cmd+K"], MAC);
    expect(user).toEqual({ "session.next": ["Cmd+K"] });
    expect(resolveKeybindings(user, MAC).bindings["view.palette"]).toEqual([]);
    // Restoring (null) or setting the defaults again removes the entry.
    expect(editKeybindings(user, "session.next", null, MAC)).toEqual({});
    expect(editKeybindings(user, "session.next", ["alt+cmd+right", "Shift+Cmd+]"], MAC)).toEqual({});
    // Unbinding is an empty list.
    expect(editKeybindings({}, "file.save", [], MAC)).toEqual({ "file.save": [] });
  });
});
