// UI-level actions shared by the sidebar and the command palette.

import { isSummary, summaryText, type Agent, type AppWindow, type PaneId, type SearchHit } from "@cmd/protocol";
import { toast } from "@cmd/ui";
import { cmd } from "./bridge.ts";
import { getState, setUi } from "./store.ts";
import { isWidget, under } from "./model.ts";
import { windowStatus } from "./windowActions.ts";
import type { OpenFrom } from "../../main/open-policy.ts";

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

/** New things go to the workspace this app window shows. */
const here = () => getState().workspaceId;

/**
 * The folder a window is in: a terminal's working directory, a file browser's
 * folder, the folder of a text or Markdown window's file (an untitled one's
 * save folder). Browser and Magic widgets have none.
 */
function folderOf(id: string | null): string | undefined {
  if (!id) return undefined;
  const s = getState();
  const pane = s.panes.get(id);
  if (pane) return pane.cwd || undefined;
  const st = s.windows.get(id)?.state as { path?: unknown; dir?: unknown } | undefined;
  const w = s.windows.get(id);
  if (!w || !st) return undefined;
  if (w.kind === "files" && typeof st.path === "string") return st.path || undefined;
  if (typeof st.path === "string" && st.path) return st.path.slice(0, st.path.lastIndexOf("/")) || "/";
  if (typeof st.dir === "string") return st.dir || undefined;
  return undefined;
}

/** The last selected window that is in a folder, for when the selected one isn't (a browser). */
let lastWithFolder: string | null = null;
export function windowSelected(id: string | null): void {
  if (folderOf(id)) lastWithFolder = id;
}

/**
 * New terminals, agents, file browsers and text windows open where the selected
 * window is (or the last selected one that is in a folder): anywhere in Home,
 * inside the root in other workspaces; otherwise (undefined) the core starts them at the root.
 */
export function contextCwd(): string | undefined {
  const cwd = folderOf(currentPane()) ?? folderOf(lastWithFolder);
  const workspace = getState().workspaces.get(here());
  return cwd && workspace && (workspace.home || under(workspace.root, cwd)) ? cwd : undefined;
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
  const agent = await cmd.call("agent.resume", { agent: h.agent, sessionId: h.sessionId, cwd: h.cwd, env: h.env, workspaceId: here() });
  if (agent.paneId) select(agent.paneId);
}

export async function newTerminal(command?: string): Promise<void> {
  const pane = await cmd.call("pane.create", { cwd: contextCwd(), command, workspaceId: here() });
  select(pane.id);
}

export async function newAgent(kind: string, prompt?: string): Promise<void> {
  const agent = await cmd.call("agent.spawn", { kind, prompt, cwd: contextCwd(), workspaceId: here() });
  if (agent.paneId) select(agent.paneId);
}

// Same names the core classifies as shells (packages/core/src/agents/procinfo.ts).
const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "csh", "nu", "xonsh", "elvish", "pwsh", "powershell", "login"]);
// cmd.exe; elsewhere `cmd` is this app's own CLI.
if (navigator.userAgent.includes("Windows")) SHELLS.add("cmd");

/**
 * Close a window. Terminals ask first when something is running (like Terminal.app),
 * text windows when they have unsaved changes (an empty Untitled has none).
 */
export async function closePane(paneId: PaneId): Promise<void> {
  const s = getState();
  const win = s.windows.get(paneId);
  if (win) {
    // An unmounted untitled window has no live status, only its draft.
    const draft = win.kind === "text" && !win.state.path && typeof win.state.draft === "string" && win.state.draft !== "";
    if (windowStatus(paneId)?.dirty || draft) {
      const ok = await cmd.confirm({
        message: `Close “${win.title}” without saving?`,
        detail: win.state.path ? "Your changes will be lost." : "It has never been saved; its text will be lost.",
        confirm: "Close",
      });
      if (!ok) return;
    }
    await cmd.call("window.close", { id: paneId });
    if (isWidget(win)) removedFromDesk(win);
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

/**
 * A widget made with Magic left the board but stays in the library
 * (docs/16-widgets.md): say so the first time, with a way back. Drafts that
 * never built are gone with their window, so they say nothing.
 */
function removedFromDesk(win: AppWindow): void {
  const widgetId = typeof win.state.widgetId === "string" ? win.state.widgetId : null;
  if (!widgetId || !win.state.revision || getState().ui["widgets.removedHint"]) return;
  setUi("widgets.removedHint", true);
  toast(`Removed “${win.title}” from the board. It's in your Widget Library.`, {
    icon: "sparkles",
    duration: 8000,
    action: { label: "Undo", run: () => void addWidget(`magic:${widgetId}`, win.workspaceId).catch(() => {}) },
  });
}

/** Copies the command that resumes an agent's session; the core builds it (env, configured command). */
export async function copyResumeCommand(a: Agent): Promise<void> {
  const c = await cmd.call("agent.resumeCommand", { agentId: a.id });
  if (c) copy(c);
}

export function sessionId(a: Agent): string | null {
  return a.native.claudeSessionId ?? a.native.codexThreadId ?? null;
}

/**
 * Summarise the agent's session into a Markdown window (docs/20-session-summaries.md).
 * The window opens with what cmd recorded and fills in as the answer streams.
 */
export async function summarizeSession(a: Agent): Promise<void> {
  try {
    const r = await cmd.call("agent.summarize", { agentId: a.id });
    if (r.windowId) select(r.windowId);
  } catch (e) {
    const msg = (e as Error).message;
    toast(msg, { tone: "danger", ...(/AI provider/.test(msg) ? { action: { label: "Set Up AI…", run: () => cmd.openSettings("ai") } } : {}) });
  }
}

/** Copy a session summary file as edited, without its marker and footer. */
export async function copySummary(path: string): Promise<void> {
  const { text } = await cmd.call("fs.read", { path });
  const out = isSummary(text) ? summaryText(text) : null;
  if (!out) return void toast("This file isn't a session summary.", { tone: "warning" });
  copy(out);
  toast("Summary copied", { tone: "success" });
}

export function copy(text: string): void {
  void navigator.clipboard.writeText(text);
}

export async function newTerminalIn(cwd: string): Promise<void> {
  const pane = await cmd.call("pane.create", { cwd, workspaceId: here() });
  select(pane.id);
}

/**
 * A new terminal in a workspace with `command` typed in, not run: the person
 * presses Return. One line without control characters, so nothing typed can
 * press Return (or end a bracketed paste) itself.
 */
export async function typeInTerminal(workspaceId: string, command: string): Promise<void> {
  const t = await cmd.call("window.open", { kind: "terminal", input: {}, workspaceId });
  select(t.id);
  await cmd.call("pane.write", { paneId: t.id, data: command.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 4000) });
}

/** New browser window (blank, address field focused, unless a URL is given). */
export async function newBrowser(url?: string): Promise<void> {
  const w = await cmd.call("window.open", { kind: "browser", input: { url }, workspaceId: here() });
  select(w.id);
}

/** A clicked http(s) link: a cmd browser window or the default browser, per `open.links`. */
export function openLink(url: string): void {
  if (getState().settings.settings["open.links"] === "browser") cmd.openPath(url, { from: "content" }); // http(s): opens without asking either way
  else void newBrowser(url);
}

/**
 * Open a path or URL in the window type that handles it (core registry); bare
 * domains get https://; anything no type handles goes to the default app.
 * `from`: "user" for menus, buttons and the palette; "content" for links in
 * terminal output and files (main confirms those first if they'd launch something).
 */
/**
 * A file at a line, in a text window (a search result): the one already showing
 * it in this workspace, else a new one; `found` (the text found) is selected there.
 */
export async function openFileAt(path: string, line: number, column: number | null, found: string | null): Promise<void> {
  const reveal = { line, column, text: found, at: Date.now() };
  const open = [...getState().windows.values()].find((w) => w.kind === "text" && w.workspaceId === here() && w.state.path === path);
  const w = open ? await cmd.call("window.update", { id: open.id, state: { reveal } }) : await cmd.call("window.open", { kind: "text", input: { path, reveal }, workspaceId: here() });
  select(w.id);
}

export async function openPath(target: string, from: OpenFrom): Promise<void> {
  const t = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(target) || /^localhost(:\d+)?/i.test(target) ? `https://${target}`.replace("https://localhost", "http://localhost") : target;
  const w = await cmd.call("window.openTarget", { target: t, workspaceId: here() }).catch(() => null);
  if (w) select(w.id);
  else cmd.openPath(t, { from });
}

/** Put a widget from the library (`type:timer`, `magic:<id>`) on the board; throws when it can't. */
/** Adds a widget; a built-in one is about the selected terminal's folder (Live Diff shows that repository). */
export async function addWidget(ref: string, workspaceId: string = here()): Promise<void> {
  const w = await cmd.call("widget.add", { ref, workspaceId, cwd: contextCwd() });
  select(w.id);
}

/** A new widget made with Magic (docs/12-magic-widgets.md); with a request, it starts making it right away. */
export async function newMagic(prompt?: string): Promise<void> {
  const w = await cmd.call("window.open", { kind: "magic", input: {}, workspaceId: here() });
  select(w.id);
  if (prompt?.trim()) await cmd.call("magic.run", { id: w.id, prompt });
}

/** New file browser at a folder, defaulting to the selected terminal's folder. */
export async function newFiles(path?: string): Promise<void> {
  const w = await cmd.call("window.open", { kind: "files", input: { path: path ?? contextCwd() }, workspaceId: here() });
  select(w.id);
}

/** New untitled text window; its first ⌘S asks where to save, starting in the selected terminal's folder. */
export async function newText(): Promise<void> {
  const w = await cmd.call("window.open", { kind: "text", input: { cwd: contextCwd() }, workspaceId: here() });
  select(w.id);
}
