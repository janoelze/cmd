// What New… (⌘N, the top bar's +) offers: every kind of window first, then the
// widgets in the library (yours by last use, then the built-in ones), then
// Magic. Typing a URL or a path opens it; any other text makes a widget of it.
// Each window runs its own command, so it opens where that command would.

import type { WidgetEntry } from "@cmd/protocol";
import { COMMAND_BY_ID, prettyAccelerator, type CommandId, type Keybindings } from "../../shared/commands.ts";
import type { PaletteItem } from "./components/Palette.tsx";
import { openPath } from "./actions.ts";

export const NEW_GROUPS = ["Open", "Windows", "Widgets"];

const WINDOWS: { id: CommandId; icon: string }[] = [
  { id: "file.newTerminal", icon: "terminal" },
  { id: "file.newClaude", icon: "text.bubble" },
  { id: "file.newCodex", icon: "text.bubble" },
  { id: "file.newBrowser", icon: "globe" },
  { id: "file.newFiles", icon: "folder" },
  { id: "file.newText", icon: "doc.text" },
];

/** The windows and widgets, in the order New… lists them. */
export function newItems(library: WidgetEntry[], bindings: Keybindings, run: (id: CommandId) => void, add: (ref: string) => void): PaletteItem[] {
  const windows = WINDOWS.map(({ id, icon }) => ({
    id,
    group: "Windows",
    // "New Terminal" → "Terminal": the picker is already New….
    label: COMMAND_BY_ID.get(id)!.label.replace(/^New /, ""),
    icon,
    hint: prettyAccelerator(bindings[id]?.[0]),
    run: () => run(id),
  }));
  const used = (e: WidgetEntry) => e.usedAt ?? e.createdAt ?? 0;
  const yours = library.filter((e) => e.source === "yours").sort((a, b) => used(b) - used(a));
  const widgets = [...yours, ...library.filter((e) => e.source === "builtin")].map((e) => ({
    id: e.ref,
    group: "Widgets",
    label: e.title,
    icon: e.icon,
    run: () => add(e.ref),
  }));
  return [...windows, ...widgets];
}

/** A typed URL or path, to open in the window that suits it; `icon` where the picker's rows have them. */
export function openItems(query: string, group: string, o: { icon?: boolean } = {}): PaletteItem[] {
  const t = openableTarget(query);
  if (!t) return [];
  const icon = o.icon ? { icon: t.kind === "url" ? "globe" : "folder" } : {};
  return [{ id: `open-${t.kind}`, group, label: `Open ${t.value}`, hint: t.kind, ...icon, run: () => void openPath(t.value, "user") }];
}

/** Last: New Widget with Magic, or, with text typed, a widget made from it. */
export function magicItem(query: string, bindings: Keybindings, make: (prompt?: string) => void): PaletteItem[] {
  const q = query.trim();
  if (openableTarget(q)) return [];
  return q
    ? [{ id: "magic-prompt", group: "Widgets", label: `Make “${q}” with Magic`, icon: "sparkles", run: () => make(q) }]
    : [{ id: "file.newMagic", group: "Widgets", label: "New Widget with Magic", icon: "sparkles", hint: prettyAccelerator(bindings["file.newMagic"]?.[0]), run: () => make() }];
}

/** Does typed text look like a URL or a path we can open? */
export function openableTarget(text: string): { kind: "url" | "path"; value: string } | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  if (/^[a-z][\w+.-]+:\/\//i.test(t) || /^(localhost(:\d+)?|127\.0\.0\.1)/i.test(t) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(t)) {
    return { kind: "url", value: t };
  }
  if (/^(~|\/)/.test(t)) return { kind: "path", value: t };
  return null;
}
