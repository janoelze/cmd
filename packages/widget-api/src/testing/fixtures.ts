// Fixture data for widget tests (`fixtures.agent({ name: "Tours", state: "waiting" })`):
// whole API objects from a few fields, with ids derived from the name (agent "Tours" is
// a-tours in window w-tours, terminal t-tours) so a test can name what it expects.

import type { ApiAgent, ApiAgentState, ApiEvent, ApiLight, ApiTerminal, ApiWindow, ApiWorkspace } from "@cmd/protocol/widget-tree";

/** The workspace fixtures live in unless told otherwise. */
export const WORKSPACE_ID = "ws-1";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";

const BUCKET: Record<ApiAgentState, ApiAgent["bucket"]> = { starting: "rest", working: "rest", idle: "rest", waiting: "needs", done: "unseen", exited: "rest", failed: "rest" };
const LIGHT: Record<ApiAgentState, ApiLight> = { starting: "working", working: "working", idle: "idle", waiting: "needs", done: "unseen", exited: "off", failed: "danger" };
const ICON: Record<string, string> = { claude: "sparkle", codex: "terminal" };

/** A workspace. @since 1.0 */
export function workspace(over: Partial<ApiWorkspace> = {}): ApiWorkspace {
  return { id: WORKSPACE_ID, name: "app", root: "/Users/me/src/app", branch: "main", ...over };
}

/** An agent; its bucket and light follow its state unless given. @since 1.0 */
export function agent(over: Partial<ApiAgent> = {}): ApiAgent {
  const name = over.name ?? "Claude";
  const s = slug(name);
  const state = over.state ?? "working";
  const kind = over.kind ?? "claude";
  return {
    id: `a-${s}`,
    name,
    kind,
    state,
    stateSince: Date.now() - 60_000,
    bucket: BUCKET[state],
    light: LIGHT[state],
    icon: ICON[kind] ?? "terminal",
    statusLine: null,
    place: "main",
    cwd: "/Users/me/src/app",
    workspaceId: WORKSPACE_ID,
    windowId: `w-${s}`,
    terminalId: `t-${s}`,
    parentId: null,
    depth: 0,
    ...over,
  };
}

/** A terminal (a pane), with what its screen shows for `terminals.read`. @since 1.0 */
export function pane(over: Partial<ApiTerminal> & { screen?: string } = {}): ApiTerminal & { screen: string } {
  const title = over.title ?? "zsh";
  const s = slug(title);
  return { id: `t-${s}`, title, cwd: "/Users/me/src/app", workspaceId: WORKSPACE_ID, windowId: `w-${s}`, command: null, agentId: null, screen: "", ...over };
}

/** A window. @since 1.0 */
export function window(over: Partial<ApiWindow> = {}): ApiWindow {
  const title = over.title ?? "zsh";
  return { id: `w-${slug(title)}`, kind: "terminal", title, workspaceId: WORKSPACE_ID, selected: false, ...over };
}

let nextEvent = 1;

/** An event from the log (a finished command by default; `key` defaults to its id, `until` to `at`). @since 1.0 */
export function event(over: Partial<ApiEvent> = {}): ApiEvent {
  const id = nextEvent++;
  const at = over.at ?? Date.now();
  return { id, at, type: "command", workspaceId: WORKSPACE_ID, data: {}, key: `event-${id}`, until: at, terminalId: null, ...over };
}

/**
 * A command as the log keeps it: running while `exitCode` is undefined, else ended with it;
 * `ago` is how long ago it started (ms), `took` how long it ran. @since 1.1
 */
export function command(over: { command?: string; cwd?: string; exitCode?: number | null; ago?: number; took?: number; terminalId?: string | null; branch?: string; key?: string; workspaceId?: string } = {}): ApiEvent {
  const at = Date.now() - (over.ago ?? 60_000);
  const running = over.exitCode === undefined;
  return event({
    at,
    until: running ? null : at + (over.took ?? 1500),
    terminalId: over.terminalId === undefined ? "t-zsh" : over.terminalId,
    workspaceId: over.workspaceId ?? WORKSPACE_ID,
    ...(over.key ? { key: over.key } : {}),
    data: { command: over.command ?? "pnpm test", exitCode: running ? null : over.exitCode!, cwd: over.cwd ?? "/Users/me/src/app", git: over.branch ? { branch: over.branch } : null, output: null },
  });
}

/** The fixtures: `fixtures.agent()`, `pane()`, `window()`, `event()`, `command()` (1.1), `workspace()`. @since 1.0 */
export const fixtures = { agent, pane, window, event, command, workspace };
