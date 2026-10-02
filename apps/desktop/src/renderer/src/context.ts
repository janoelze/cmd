// Native context menus: build items with handlers, let main show them.

import { cmd } from "./bridge.ts";

export type MenuEntry = { label: string; run: () => void; enabled?: boolean } | "-";

export async function showContextMenu(entries: MenuEntry[]): Promise<void> {
  const items = entries.map((e, i) =>
    e === "-" ? { separator: true as const } : { id: String(i), label: e.label, enabled: e.enabled ?? true },
  );
  const chosen = await cmd.contextMenu(items);
  if (chosen === null) return;
  const e = entries[Number(chosen)];
  if (e && e !== "-") e.run();
}
