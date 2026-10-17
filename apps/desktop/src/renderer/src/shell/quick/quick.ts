// Quick Commands in an app window (docs/58): the person's list from the core, kept current;
// what one takes from the window it runs for (its folder, file, selection, page); and running
// one from the Session menu (`quick:<id>`), its shortcut or the palette, through the Quick
// Command sheet when it asks for values or a yes first.

import { useSyncExternalStore } from "react";
import { parseQuick, QUICK_TITLE, type QuickCommand, type QuickContext, type QuickList, type QuickResolved } from "@cmd/protocol";
import { toast } from "@cmd/ui";
import { prettyAccelerator, QUICK_PREFIX, type MenuLists, type MenuState, type QuickMenuId } from "../../../../shared/commands.ts";
import { cmd } from "../../lib/bridge.ts";
import { goTo } from "../../lib/widgets.ts";
import { stateStr } from "../../windows/registry.ts";
import { terminals } from "../../windows/terminal/terminals.ts";
import { commandContext, type CommandContext, type Target } from "../commands/registry.ts";
import type { PaletteItem } from "../Palette.tsx";
import { openSheet } from "../sheets.ts";

let list: QuickList = { commands: [], path: "" };
const listeners = new Set<() => void>();
let started = false;

async function load(): Promise<void> {
  if (!cmd.has("quick.list")) return;
  list = await cmd.call("quick.list", {});
  for (const fn of listeners) fn();
}

/** Read the list, and again whenever it changes or the core comes back. Once per app window. */
function start(): void {
  if (started) return;
  started = true;
  cmd.onEvent((e) => e.type === "quick.changed" && void load().catch(() => {}));
  cmd.onStatus((s) => s === "connected" && void load().catch(() => {}));
  void load().catch(() => {});
}

export function quickCommands(): QuickCommand[] {
  start();
  return list.commands;
}

export function useQuickCommands(): QuickCommand[] {
  start();
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => list.commands,
  );
}

/** What a Quick Command can take from the window it runs for. */
export function quickContext(c: CommandContext): QuickContext {
  const w = c.window;
  const paneId = c.pane?.id;
  const text = w && c.actions?.text?.selection?.();
  const path = w && w.kind !== "files" && w.kind !== "browser" ? stateStr(w, "path") : undefined;
  return {
    workspaceId: c.workspace?.id,
    paneId,
    folder: c.folder,
    file: path ?? undefined,
    selection: (paneId && terminals.hasSelection(paneId) ? terminals.get(paneId).term.getSelection() : text) || undefined,
    url: w?.kind === "browser" ? (stateStr(w, "url") ?? undefined) : undefined,
  };
}

/** Whether it can run here: a body that parses, and the file, selection or page it needs is there (the core knows the rest). */
export function quickApplies(q: QuickCommand, ctx: QuickContext): boolean {
  const p = parseQuick(q.body);
  if (p.errors.length) return false;
  const needed = p.parts.flatMap((t) => (typeof t !== "string" && t.kind === "var" && !t.optional ? [t.name] : []));
  return needed.every((n) => (n === "file" ? !!ctx.file : n === "selection" ? !!ctx.selection : n === "url" ? !!ctx.url : true));
}

/** A run waiting in the Quick Command sheet: what it asks for, or a yes. */
export interface QuickPending {
  command: QuickCommand;
  context: QuickContext;
  resolved: QuickResolved;
}

/** Run one for `target` (the selection by default): through the sheet when it asks first, else at once. */
export async function runQuickCommand(id: string, target?: Target): Promise<void> {
  const command = quickCommands().find((q) => q.id === id);
  if (!command) return;
  const context = quickContext(commandContext(target));
  try {
    const resolved = await cmd.call("quick.resolve", { id, context });
    if (resolved.asks.length || command.confirm) return openSheet({ kind: "quick", pending: { command, context, resolved } });
    await finishQuick(command, context, {});
  } catch (err) {
    toast((err as Error).message, { tone: "danger" });
  }
}

/** Run it with the values given; the terminal or window it went to is shown. */
export async function finishQuick(command: QuickCommand, context: QuickContext, values: Record<string, string>): Promise<void> {
  const r = await cmd.call("quick.run", { id: command.id, context, values, confirmed: true });
  const to = r.windowId ?? (r.paneId !== context.paneId ? r.paneId : undefined);
  if (to) goTo(to, context.workspaceId);
}

const menuId = (q: QuickCommand): QuickMenuId => `${QUICK_PREFIX}${q.id}`;

/** A menu item's id (`quick:<id>`) as the command's; null for any other. */
export const quickOfMenuId = (id: string): string | null => (id.startsWith(QUICK_PREFIX) ? id.slice(QUICK_PREFIX.length) : null);

/** Session → Quick Commands' items, and which apply now (menuState). */
export function quickMenu(c: CommandContext): { quick: NonNullable<MenuLists["quick"]>; enabled: MenuState["enabled"] } {
  const ctx = quickContext(c);
  const enabled: MenuState["enabled"] = {};
  const quick = quickCommands().map((q) => {
    enabled[menuId(q)] = quickApplies(q, ctx);
    return { id: menuId(q), label: q.name, keys: q.keys ?? [] };
  });
  return { quick, enabled };
}

/** The palette's Quick Commands group: those that apply here, with their shortcuts. */
export function quickItems(c: CommandContext): PaletteItem[] {
  const ctx = quickContext(c);
  return quickCommands()
    .filter((q) => quickApplies(q, ctx))
    .map((q) => ({ id: `q-${q.id}`, group: QUICK_TITLE, icon: "bolt", label: q.name, meta: q.description || q.body, hint: prettyAccelerator(q.keys?.[0]), run: () => void runQuickCommand(q.id) }));
}
