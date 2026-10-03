// UI-level actions shared by the sidebar and the command palette.

import type { Agent, PaneId, SearchHit } from "@cmd/protocol";
import { cmd } from "./bridge.ts";
import { getState } from "./store.ts";

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

/** Session ids of agents open in a terminal (transcript search leaves them out of Recent). */
export function liveSessionIds(): string[] {
  return [...getState().agents.values()].flatMap((a) => (a.paneId ? [a.native.claudeSessionId, a.native.codexThreadId] : [])).filter((x): x is string => !!x);
}

/** Switch to a past session if it is open in a terminal, otherwise resume it in a new one. */
export async function openSession(h: SearchHit): Promise<void> {
  const live = [...getState().agents.values()].find(
    (a) => a.paneId && (a.native.claudeSessionId === h.sessionId || a.native.codexThreadId === h.sessionId),
  );
  if (live?.paneId) return select(live.paneId);
  const agent = await cmd.call("agent.resume", { agent: h.agent, sessionId: h.sessionId, cwd: h.cwd, configDir: h.configDir });
  if (agent.paneId) select(agent.paneId);
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

/** Close a window. Terminals ask first when something is running (like Terminal.app). */
export async function closePane(paneId: PaneId): Promise<void> {
  const s = getState();
  if (s.windows.has(paneId)) {
    await cmd.call("window.close", { id: paneId });
    return;
  }
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

/** New browser window (blank, address field focused, unless a URL is given). */
export async function newBrowser(url?: string): Promise<void> {
  const w = await cmd.call("window.open", { kind: "browser", input: { url } });
  select(w.id);
}

/**
 * Open a path or URL in the window type that handles it (core registry); bare
 * domains get https://; anything no type handles goes to the default app.
 */
export async function openPath(target: string): Promise<void> {
  const t = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(target) || /^localhost(:\d+)?/i.test(target) ? `https://${target}`.replace("https://localhost", "http://localhost") : target;
  const w = await cmd.call("window.openTarget", { target: t }).catch(() => null);
  if (w) select(w.id);
  else cmd.openPath(t);
}

/** New file browser at a folder, defaulting to the selected terminal's folder. */
export async function newFiles(path?: string): Promise<void> {
  const w = await cmd.call("window.open", { kind: "files", input: { path: path ?? contextCwd() } });
  select(w.id);
}

/** Does palette input look like a URL or a path we can open? */
export function openableTarget(text: string): { kind: "url" | "path"; value: string } | null {
  const t = text.trim();
  if (!t || /\s/.test(t)) return null;
  if (/^[a-z][\w+.-]+:\/\//i.test(t) || /^(localhost(:\d+)?|127\.0\.0\.1)/i.test(t) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(t)) {
    return { kind: "url", value: t };
  }
  if (/^(~|\/)/.test(t)) return { kind: "path", value: t };
  return null;
}
