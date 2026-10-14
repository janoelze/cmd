// The menu bar comes from the command list (main/menu-template.ts): every command is in it
// exactly once, shown or hidden, on macOS and elsewhere, and a window's own shortcut doesn't
// register with the menu (the window runs it).
import { describe, expect, it } from "vitest";
import type { MenuItemConstructorOptions } from "electron";
import { contextTemplate, menuSlots, menuTemplate } from "../src/main/menu-template.ts";
import { COMMANDS, DEFAULT_KEYBINDINGS, type CommandSpec } from "../src/shared/commands.ts";

const flat = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] => items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flat(i.submenu) : [])]);

describe("the menu bar", () => {
  for (const mac of [true, false]) {
    it(`places every command exactly once (${mac ? "macOS" : "Windows/Linux"})`, () => {
      const items = flat(menuTemplate(() => {}, DEFAULT_KEYBINDINGS, { mac, appName: "cmd" }));
      const ids = items.flatMap((i) => (i.id ? [i.id] : []));
      for (const c of COMMANDS) expect(ids.filter((id) => id === c.id), c.id).toHaveLength(1);
      expect(ids.length).toBe(COMMANDS.length);
    });
  }

  it("has a group for every command's slot", () => {
    const slots = new Set(menuSlots(true));
    expect((COMMANDS as readonly CommandSpec[]).filter((c) => !slots.has(c.menu)).map((c) => c.id)).toEqual([]);
  });

  it("leaves a window's own shortcuts to the window", () => {
    const items = flat(menuTemplate(() => {}, DEFAULT_KEYBINDINGS, { mac: true, appName: "cmd" }));
    for (const c of (COMMANDS as readonly CommandSpec[]).filter((c) => c.scope === "window")) {
      expect(items.find((i) => i.id === c.id)?.registerAccelerator, c.id).toBe(false);
    }
  });

  it("lists the open workspaces under ⌃1–9 and the closed ones in File → Open Recent", () => {
    const opened: string[] = [];
    const lists = { workspaces: ["Home", "cmd"], recent: [{ path: "/src/blog", label: "blog" }] };
    const items = flat(menuTemplate(() => {}, DEFAULT_KEYBINDINGS, { mac: true, appName: "cmd", lists, openRecent: (p) => opened.push(p) }));
    expect(items.find((i) => i.id === "workspace.select2")).toMatchObject({ label: "cmd", type: "checkbox" });
    expect(items.find((i) => i.id === "workspace.select2")?.visible).not.toBe(false);
    expect(items.find((i) => i.id === "workspace.select3")).toMatchObject({ visible: false, acceleratorWorksWhenHidden: true });
    const recent = items.find((i) => i.label === "Open Recent")!;
    const blog = (recent.submenu as MenuItemConstructorOptions[])[0]!;
    blog.click!(undefined as never, undefined, undefined as never);
    expect(opened).toEqual(["/src/blog"]);
    const none = flat(menuTemplate(() => {}, DEFAULT_KEYBINDINGS, { mac: true, appName: "cmd" })).find((i) => i.label === "Open Recent")!;
    expect(none.submenu).toEqual([{ label: "No Recent Workspaces", enabled: false }]);
  });

  it("shows a context-menu entry's shortcut when it is a command, without taking the key", () => {
    const [cmdItem, plain] = contextTemplate([{ id: "0", label: "Copy Session ID", accelerator: "Alt+Cmd+C" }, { id: "1", label: "Paste" }], () => {});
    expect(cmdItem).toMatchObject({ accelerator: "Alt+Cmd+C", registerAccelerator: false });
    expect(plain!.accelerator).toBeUndefined();
  });
});
