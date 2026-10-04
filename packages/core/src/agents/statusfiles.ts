// Agent hook status files, in the format of the ghostty-agents fork, so the hook
// that is already installed (~/.claude/hooks/ghostty-agents-status.sh) works
// unchanged:
//
//   $TMPDIR/ghostty-agents/<pane-id>/<HookEventName>.json
//   = {"agent": "claude", "ts": <unix s>, "event": <raw hook payload>}
//
// Every pane is started with GHOSTTY_AGENTS_SURFACE_ID=<pane-id>. The hook is a
// tiny shell script that only writes files, so it is fast (runs on every tool
// call), works inside sandboxes, and works while the core is down: status is
// re-derived from the whole file set whenever it changes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { AgentState, PaneId } from "@cmd/protocol";
import { describeTool } from "./state.ts";

export const STATUS_ENV = "GHOSTTY_AGENTS_SURFACE_ID";

export function statusRoot(): string {
  return path.join(os.tmpdir(), "ghostty-agents");
}

export interface HookStatus {
  state: AgentState;
  agent: string | null;
  sessionId: string | null;
  lastPrompt: string | null;
  /** Question or permission request when state is needs_input. */
  message: string | null;
  /** Current tool call, e.g. "Editing panes.ts". */
  activity: string | null;
  cwd: string | null;
  transcriptPath: string | null;
  updatedAt: number;
}

interface Ev {
  name: string;
  agent: string | null;
  date: number;
  payload: Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const firstLine = (s: string) => (s.split(/\r?\n/)[0] ?? s).trim();

/** Events applyHook ignores when they come from a subagent. */
const SUBAGENT_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PreCompact", "PostCompact"]);

function stateOf(e: Ev): AgentState | null {
  switch (e.name) {
    case "SessionStart":
      return "idle";
    case "Stop":
      return "done";
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PreCompact":
    case "PostCompact":
      return "working";
    case "PermissionRequest":
      return "needs_input";
    case "StopFailure":
      return "failed";
    case "Notification":
      // An idle reminder after a turn adds nothing beyond Stop; anything else
      // (permission prompts, questions) needs the user.
      return e.payload.notification_type === "idle_prompt" ? "done" : "needs_input";
    default:
      return null;
  }
}

function readEvents(dir: string): Ev[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Ev[] = [];
  for (const n of names) {
    if (n.startsWith(".") || !n.endsWith(".json")) continue;
    const file = path.join(dir, n);
    try {
      const root = JSON.parse(fs.readFileSync(file, "utf8")) as { agent?: string; ts?: number; event?: Record<string, unknown> };
      if (!root.event || typeof root.event !== "object") continue;
      // mtime has sub-second precision; several hooks often fire within one second.
      const date = fs.statSync(file).mtimeMs || (root.ts ?? 0) * 1000;
      out.push({ name: str(root.event.hook_event_name) ?? n.slice(0, -5), agent: str(root.agent), date, payload: root.event });
    } catch {
      // half-written or foreign file
    }
  }
  return out.sort((a, b) => a.date - b.date);
}

/**
 * Port of the fork's AgentStatusStore.status(for:).
 * `notBefore` (process start, ms) drops status left over from an earlier agent.
 */
export function deriveStatus(events: Ev[], notBefore = 0): HookStatus | null {
  let evs = events.filter((e) => e.date >= notBefore);
  // A terminal can run several sessions in a row (/clear, resume). Only the newest counts.
  const current = str(evs.at(-1)?.payload.session_id);
  if (current) evs = evs.filter((e) => (str(e.payload.session_id) ?? current) === current);
  // Tool calls from inside a Claude subagent (they carry agent_id) describe the child,
  // not the agent in the pane, as in applyHook: a background subagent must not turn a
  // finished agent back to working.
  evs = evs.filter((e) => !(str(e.payload.agent_id) && SUBAGENT_EVENTS.has(e.name)));
  const latest = evs.findLast((e) => stateOf(e) !== null);
  if (!latest) return null;

  const prompt = evs.findLast((e) => e.name === "UserPromptSubmit");
  const tool = evs.findLast((e) => e.name === "PreToolUse");
  const activity =
    tool && tool.date >= (prompt?.date ?? 0)
      ? describeTool(str(tool.payload.tool_name) ?? undefined, tool.payload.tool_input as Record<string, unknown> | undefined)
      : null;
  const message = str(latest.payload.message);

  return {
    state: stateOf(latest)!,
    agent: latest.agent,
    sessionId: str(latest.payload.session_id),
    lastPrompt: str(prompt?.payload.prompt) ? firstLine(str(prompt!.payload.prompt)!) : null,
    message: message ? firstLine(message) : null,
    activity,
    cwd: str(evs.findLast((e) => str(e.payload.cwd))?.payload.cwd),
    transcriptPath: str(evs.findLast((e) => str(e.payload.transcript_path))?.payload.transcript_path),
    updatedAt: latest.date,
  };
}

export function readStatus(paneId: PaneId, notBefore = 0, root = statusRoot()): HookStatus | null {
  return deriveStatus(readEvents(path.join(root, paneId)), notBefore);
}

export function removeStatus(paneId: PaneId, root = statusRoot()): void {
  fs.rmSync(path.join(root, paneId), { recursive: true, force: true });
}

/** Emits `changed(paneId)` when a pane's status files change. */
export class StatusWatcher extends EventEmitter<{ changed: [PaneId] }> {
  #watcher: fs.FSWatcher | null = null;
  #timers = new Map<string, NodeJS.Timeout>();
  readonly root: string;

  constructor(root = statusRoot()) {
    super();
    this.root = root;
  }

  start(): void {
    fs.mkdirSync(this.root, { recursive: true });
    this.#watcher = fs.watch(this.root, { recursive: true }, (_e, name) => {
      const id = name?.toString().split(path.sep)[0];
      if (!id) return;
      clearTimeout(this.#timers.get(id));
      this.#timers.set(
        id,
        setTimeout(() => {
          this.#timers.delete(id);
          this.emit("changed", id);
        }, 30),
      );
    });
    this.#watcher.unref();
  }

  close(): void {
    this.#watcher?.close();
    for (const t of this.#timers.values()) clearTimeout(t);
  }
}

export { firstLine };
