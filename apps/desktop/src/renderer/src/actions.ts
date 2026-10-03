// UI-level actions shared by the sidebar, tools and the command palette.

import type { Agent, PaneId } from "@cmd/protocol";
import { cmd } from "./bridge.ts";
import { getState } from "./store.ts";
import type { ToolAction } from "./tools.ts";

type Selector = (paneId: PaneId) => void;
let select: Selector = () => {};
let currentPane: () => PaneId | null = () => null;

/** Select a pane from outside React (e.g. after resuming a session). */
export function selectPane(id: PaneId): void {
  select(id);
}

export function bindSelection(fn: Selector, current: () => PaneId | null): void {
  select = fn;
  currentPane = current;
}

/** New panes inherit the working directory of the selected pane. */
function contextCwd(): string | undefined {
  const id = currentPane();
  return id ? getState().panes.get(id)?.cwd : undefined;
}

export async function newTerminal(command?: string): Promise<void> {
  const pane = await cmd.call("pane.create", { cwd: contextCwd(), command });
  select(pane.id);
}

export async function newAgent(kind: string, prompt?: string): Promise<void> {
  const agent = await cmd.call("agent.spawn", { kind, prompt, cwd: contextCwd() });
  if (agent.paneId) select(agent.paneId);
}

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "nu", "login"]);

/** Like Terminal.app: ask before closing a terminal that is running something. */
export async function closePane(paneId: PaneId): Promise<void> {
  const s = getState();
  const pane = s.panes.get(paneId);
  if (!pane) return;
  const agent = pane.agentId ? s.agents.get(pane.agentId) : undefined;
  const busy = !SHELLS.has(pane.foreground.replace(/^-/, ""));
  if (busy || agent) {
    const what = agent ? `${agent.kind}${agent.name ? ` (${agent.name})` : ""}` : pane.foreground;
    const ok = await cmd.confirm({
      message: `Close this terminal?`,
      detail: `${what} is still running. Closing the terminal will end it.${agent?.native.claudeSessionId || agent?.native.codexThreadId ? " You can resume the session later." : ""}`,
      confirm: "Close",
    });
    if (!ok) return;
  }
  await cmd.call("pane.kill", { paneId });
}

export function resumeCommand(a: Agent): string | null {
  const cd = `cd ${JSON.stringify(a.cwd)} && `;
  if (a.native.claudeSessionId) return `${cd}claude --resume ${a.native.claudeSessionId}`;
  if (a.native.codexThreadId) return `${cd}codex resume ${a.native.codexThreadId}`;
  return null;
}

export function sessionId(a: Agent): string | null {
  return a.native.claudeSessionId ?? a.native.codexThreadId ?? null;
}

export function copy(text: string): void {
  void navigator.clipboard.writeText(text);
}

export async function newTerminalIn(cwd: string): Promise<void> {
  const pane = await cmd.call("pane.create", { cwd });
  select(pane.id);
}

export function runAction(a: ToolAction): Promise<void> {
  return a.kind === "terminal" ? newTerminal(a.command) : newAgent(a.agent, a.prompt);
}
