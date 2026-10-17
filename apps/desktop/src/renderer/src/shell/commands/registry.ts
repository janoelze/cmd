// The renderer's half of the app commands (shared/commands.ts is the other): what each does,
// when it applies and whether it is checked, registered by the module it belongs to (the
// shell's in shell/commands/, a window type's beside its view). Everything that shows a
// command derives from here: the menu bar's enabled and checked items, the palette (which
// leaves out what doesn't apply), context menus (an entry can be a command, run for the row
// it is on) and a window's own shortcuts (CommandSpec.scope "window").

import { useEffect, useSyncExternalStore } from "react";
import type { Agent, AppWindow, Pane, WindowId, Workspace, WorkspaceId } from "@cmd/protocol";
import { needsAttention } from "@cmd/protocol";
import { COMMAND_BY_ID, COMMANDS, norm, type CommandId, type CommandSpec, type MenuState } from "../../../../shared/commands.ts";
import { aiStatus, useAiStatus } from "../../ai/status.ts";
import { sessionId } from "../../lib/actions.ts";
import { cmd } from "../../lib/bridge.ts";
import type { MenuEntry } from "../../lib/context.ts";
import { acceleratorOf, keybindings } from "../../lib/keybindings.ts";
import { windowAttention, windowIdOf } from "../../lib/model.ts";
import { selected as selection } from "../../lib/selection.ts";
import { getState, useStore, type State } from "../../lib/store.ts";
import { useWindowActions, windowActions, type WindowActions } from "../../lib/windowActions.ts";
import { boardOf, type Board } from "../board/board.ts";
import { terminals } from "../../windows/terminal/terminals.ts";
import { recentLabels, useRecentWorkspaces } from "../workspaces.tsx";
import { sideOf, type Side } from "../board/docks.ts";
import { stateStr } from "../../windows/registry.ts";
import { quickMenu, useQuickCommands } from "../quick/quick.ts";

/** What a command can see: the shown workspace, the window it is for (the selection, or a row's), and the app around it. */
export interface CommandContext {
  state: State;
  board: Board;
  workspace: Workspace | undefined;
  /** Open workspaces in the switcher's order. */
  workspaces: Workspace[];
  /** The window the command is for: the selected one, or the one a context menu is on. */
  selected: WindowId | null;
  pane: Pane | undefined;
  window: AppWindow | undefined;
  /** The agent it shows (or the agent row a context menu is on), and its session. */
  agent: Agent | null;
  session: string | null;
  aiReady: boolean;
  /** What the window's content offers (save, find, zoom…: lib/windowActions.ts). */
  actions: WindowActions | undefined;
  /** The sidebar the window is docked in. */
  side: Side | null;
  /** The folder it is in: an agent's or terminal's working directory, a file browser's folder, a file's. */
  folder: string | undefined;
  /** A text field has focus (a palette, a text window's editor): Edit commands go to it. */
  editing: boolean;
  /** Agents, terminals and widgets waiting for you, in every workspace. */
  attention: number;
  canReopen: boolean;
}

export interface Command {
  run(c: CommandContext): void;
  /** Whether it applies (default: always). Off: disabled in the menu bar and context menus, left out of the palette. */
  when?(c: CommandContext): boolean;
  /** For radio and checkbox commands (CommandSpec.checkable). */
  checked?(c: CommandContext): boolean;
}

/** What a command runs for when it isn't the selection: a window, an agent (a subagent's row) or a workspace. */
export interface Target {
  windowId?: WindowId | null;
  agentId?: string;
  workspaceId?: WorkspaceId;
}

const registry = new Map<string, Command>();

/** Each module registers the commands it implements; one id has one implementation. */
export function registerCommands(commands: { [K in CommandId]?: Command }): void {
  for (const [id, c] of Object.entries(commands)) {
    if (!COMMAND_BY_ID.has(id)) throw new Error(`no such command: ${id}`);
    // A module that runs again (hot reload in development) replaces its own.
    if (registry.has(id) && !import.meta.hot) throw new Error(`${id} is registered twice`);
    registry.set(id, c!);
  }
}

export const registeredCommands = (): ReadonlySet<string> => new Set(registry.keys());

/** A text field (a palette, settings, a text window's CodeMirror) has focus, not a terminal. */
export function editingText(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.closest(".xterm");
}

/** A file browser's folder, a file's (text, Markdown, PDF…); none for a browser or widget. */
function folderOf(w: AppWindow | undefined): string | undefined {
  const p = w && stateStr(w, "path");
  if (!p) return undefined;
  return w.kind === "files" ? p : p.slice(0, p.lastIndexOf("/")) || "/";
}

export function commandContext(target: Target = {}, state: State = getState()): CommandContext {
  const board = boardOf(state);
  const workspaces = [...state.workspaces.values()].sort((a, b) => a.order - b.order);
  const selected = target.windowId !== undefined ? target.windowId : target.agentId ? null : selection();
  const pane = selected ? state.panes.get(selected) : undefined;
  const window = selected && !pane ? state.windows.get(selected) : undefined;
  const agent = target.agentId ? (state.agents.get(target.agentId) ?? null) : (board.allFlat.find((r) => windowIdOf(r) === selected)?.agent ?? null);
  return {
    state,
    board,
    workspace: state.workspaces.get(target.workspaceId ?? state.workspaceId),
    workspaces,
    selected,
    pane,
    window,
    agent,
    session: agent ? sessionId(agent) : null,
    aiReady: !!aiStatus()?.ready,
    actions: windowActions(selected),
    side: sideOf(board.docks, selected),
    folder: agent?.cwd ?? pane?.cwd ?? folderOf(window),
    editing: editingText(),
    attention:
      [...state.agents.values()].filter(needsAttention).length +
      [...state.panes.values()].filter((p) => p.attention && !p.agentId).length +
      [...state.windows.values()].filter((w) => windowAttention(w)).length,
    canReopen: state.closed.some((c) => c.workspaceId === state.workspaceId),
  };
}

export function applies(id: string, c: CommandContext = commandContext()): boolean {
  const command = registry.get(id);
  return !!command && (command.when?.(c) ?? true);
}

export type Via = "palette" | "menu" | "shortcut" | "cli" | "other";

/** Run a command if it applies; every one that runs is a fact in the log (user.command): which, and from where. */
export function runCommand(id: string, via: Via = "other", target?: Target): void {
  const command = registry.get(id);
  const c = commandContext(target);
  if (!command || !(command.when?.(c) ?? true)) return;
  command.run(c);
  void cmd.call("data.record", { event: { id: `user.command:${crypto.randomUUID()}`, at: Date.now(), type: "user.command", source: "user", data: { command: id, via } } }).catch(() => {});
}

/** The menu bar's state: every command enabled as it applies, the checkable ones checked, and the lists of workspaces. */
export function menuState(c: CommandContext, recent: Workspace[] = []): MenuState {
  const checked: MenuState["checked"] = {};
  const enabled: MenuState["enabled"] = {};
  for (const spec of COMMANDS as readonly CommandSpec[]) {
    const command = registry.get(spec.id);
    enabled[spec.id as CommandId] = !!command && (command.when?.(c) ?? true);
    if (command?.checked) checked[spec.id as CommandId] = command.checked(c);
  }
  const quick = quickMenu(c);
  const lists = { workspaces: c.workspaces.slice(0, 9).map((sp) => sp.name), recent: recentLabels(recent, 10).map((r) => ({ path: r.workspace.root, label: r.label })), quick: quick.quick };
  return { checked, enabled: { ...enabled, ...quick.enabled }, lists };
}

let lastMenu = "";

/** Focus moving between a terminal and a field changes what Copy applies to (CommandContext.editing). */
let focusVersion = 0;
const onFocus = (fn: () => void) => {
  const bump = () => (focusVersion++, fn());
  document.addEventListener("focusin", bump);
  document.addEventListener("focusout", bump);
  return () => (document.removeEventListener("focusin", bump), document.removeEventListener("focusout", bump));
};

/** Tells the menu bar what is enabled and checked, when that changes (it's IPC and native menu work): after the store, a window's actions, AI, a terminal's selection or focus change. */
export function useMenuState(): void {
  const state = useStore();
  const actions = useWindowActions(selection());
  const ai = useAiStatus();
  const textSelected = useSyncExternalStore(terminals.onSelection, terminals.selectionVersion);
  const focus = useSyncExternalStore(onFocus, () => focusVersion);
  const recent = useRecentWorkspaces();
  const quick = useQuickCommands();
  useEffect(() => {
    const m = menuState(commandContext({}, state), recent);
    const json = JSON.stringify(m);
    if (json !== lastMenu) (lastMenu = json), cmd.setMenuState(m);
  }, [state, actions, ai, textSelected, focus, recent, quick]);
}

/** useMenuState in a component of its own: what it follows changes often (focus, a window's actions), and the shell needn't render for it. */
export function MenuStateSync(): null {
  useMenuState();
  return null;
}

/** A window's own shortcuts (CommandSpec.scope "window"): run here while they apply, not by the menu, so other windows keep the keys. */
export function useWindowShortcuts(): void {
  useEffect(() => {
    const own = (COMMANDS as readonly CommandSpec[]).filter((c) => c.scope === "window");
    const onKey = (e: KeyboardEvent) => {
      const acc = acceleratorOf(e);
      if (!acc) return;
      const bindings = keybindings().bindings;
      const hit = own.find((c) => (bindings[c.id] ?? []).some((k) => norm(k) === norm(acc)));
      if (!hit || !applies(hit.id)) return;
      e.preventDefault();
      e.stopPropagation();
      runCommand(hit.id, "shortcut");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

/** A context-menu entry that is a command, run for `target`: its label (or a shorter one for the menu it is in) and shortcut, enabled as it applies. */
export function commandItem(id: CommandId, target: Target = {}, o: { label?: string } = {}): Extract<MenuEntry, { run: () => void }> {
  return {
    label: o.label ?? COMMAND_BY_ID.get(id)!.label,
    accelerator: keybindings().bindings[id]?.[0],
    enabled: applies(id, commandContext(target)),
    run: () => runCommand(id, "other", target),
  };
}
