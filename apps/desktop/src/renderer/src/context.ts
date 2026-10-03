// Native context menus: build items with handlers, let main show them.

import type { ContextItem } from "../../shared/commands.ts";
import { cmd } from "./bridge.ts";

export type MenuEntry =
  | { label: string; run: () => void; enabled?: boolean; checked?: boolean }
  | { label: string; submenu: MenuEntry[]; enabled?: boolean }
  | "-";

export async function showContextMenu(entries: MenuEntry[]): Promise<void> {
  const handlers = new Map<string, () => void>();
  const items = (list: MenuEntry[], prefix: string): ContextItem[] =>
    list.map((e, i) => {
      if (e === "-") return { separator: true as const };
      const id = prefix + i;
      if ("submenu" in e) return { id, label: e.label, enabled: e.enabled ?? true, submenu: items(e.submenu, `${id}.`) };
      handlers.set(id, e.run);
      return { id, label: e.label, enabled: e.enabled ?? true, checked: e.checked };
    });
  const chosen = await cmd.contextMenu(items(entries, ""));
  if (chosen !== null) handlers.get(chosen)?.();
}
