// File: new windows, opening workspaces, saving, closing (⌘W closes the frontmost
// thing: a sheet, the selected window, then the app window) and reopening.

import { closePane, newBrowser, newFiles, newMagic, newTerminal, newText } from "../../lib/actions.ts";
import { cmd } from "../../lib/bridge.ts";
import { reopenClosed } from "../closed.ts";
import { closeSheet, currentSheet, openSheet, toggleSheet } from "../sheets.ts";
import { registerCommands } from "./registry.ts";

registerCommands({
  // ⌘N: one picker for every new window and widget (shell/newItems.ts).
  "file.new": { run: () => toggleSheet({ kind: "picker", picker: { kind: "new" } }, (s) => s.kind === "picker" && s.picker.kind === "new") },
  "file.newTerminal": { run: () => void newTerminal() },
  "file.newBrowser": { run: () => void newBrowser() },
  "file.newFiles": { run: () => void newFiles() },
  "file.newText": { run: () => void newText() },
  // Widgets (docs/16-widgets.md): the Widget Library, and making one with Magic.
  "widget.library": { run: () => toggleSheet({ kind: "library" }) },
  "file.newMagic": { run: () => (currentSheet()?.kind === "library" && closeSheet(), void newMagic()) },
  "file.openWorkspace": { run: () => openSheet({ kind: "picker", picker: { kind: "workspace" } }) },
  "file.newWindow": { run: () => openSheet({ kind: "picker", picker: { kind: "workspace", newWindow: true } }) },
  "file.save": { when: (c) => !!c.actions?.save, run: (c) => void c.actions?.save?.() },
  // ⌘W: the frontmost thing: the open sheet, else the selected window, else the app window.
  "file.close": { run: (c) => (currentSheet() ? closeSheet() : c.selected ? void closePane(c.selected) : cmd.closeWindow()) },
  "window.close": { when: (c) => !!c.selected, run: (c) => void closePane(c.selected!) },
  "file.reopenClosed": { when: (c) => c.canReopen, run: () => reopenClosed() },
});
