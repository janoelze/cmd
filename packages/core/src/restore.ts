// Bringing terminals and agents back when the core starts.
//
// Every pane is recorded in the store (panes.ts) with the backend instance it
// ran in. On start:
//  - a terminal the PTY host kept running is taken over as it is (same id, its
//    agent still attached);
//  - a record from another instance lost its process (the host died, the Mac
//    restarted, or terminals ran in the core): it is resurrected under the same
//    id, in its folder, with its last screen and a "Restored" line. An agent
//    session is resumed by the agent's own command (claude --resume …); anything
//    else that was running is put on the command line, never run (a shell with
//    our shell integration; bash puts it in history);
//  - a record from this instance that isn't running exited while the core was
//    away: dropped.
// Pane ids stay the same, so the layouts and selections in Space.view still fit.

import fs from "node:fs";
import type { Agent, PaneId, Settings } from "@cmd/protocol";
import { ENV } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { sessionIdOf, type AgentTracker } from "./agents/tracker.ts";
import type { PaneManager } from "./panes.ts";
import type { SpaceManager } from "./spaces/manager.ts";
import type { Store } from "./store.ts";

const log = logger("restore");

/** Set in a resurrected shell: what the shell integration offers on its first command line (bash: in history). */
export const RESTORE_COMMAND_ENV = "CMD_RESTORE_COMMAND";

export interface RestoreContext {
  panes: PaneManager;
  agents: AgentTracker;
  spaces: SpaceManager;
  store: Store;
  settings: () => Settings;
}

export function restoreSession({ panes, agents, spaces, store, settings }: RestoreContext): void {
  const cfg = settings();
  const backend = panes.backend;
  const records = new Map(store.panes().map((r) => [r.id, r]));
  const stored = store.agents();
  /** Pane ids back in this core: reattached (true) or resurrected (false). */
  const back = new Map<PaneId, boolean>();
  /** The agent being resumed in each resurrected pane. */
  const resumed = new Map<PaneId, string>();
  /** What happened to each pane and agent, for the summary line (debug lines say which). */
  const tally: Record<string, number> = {};
  const count = (what: string, id: string, detail?: Record<string, unknown>) => {
    tally[what] = (tally[what] ?? 0) + 1;
    log.debug(`${id.slice(0, 8)}: ${what}`, detail);
  };
  const openSpace = (id: string) => {
    const s = spaces.get(id);
    return s && s.closedAt === null ? s : null;
  };

  for (const term of backend.attached()) {
    const rec = records.get(term.id) ?? null;
    records.delete(term.id);
    // Its Space went away meanwhile (closed elsewhere, forgotten): it goes Home.
    panes.adopt(term, rec && { ...rec, spaceId: openSpace(rec.spaceId)?.id ?? spaces.home().id });
    back.set(term.id, true);
    count(rec ? "reattached" : "reattached without a record", term.id);
  }

  const hosted = new Map<PaneId, Agent>();
  for (const a of stored) if (a.paneId && !hosted.has(a.paneId)) hosted.set(a.paneId, a);
  for (const rec of records.values()) {
    const space = openSpace(rec.spaceId);
    const drop =
      rec.host === backend.instance ? "dropped: exited while the core was away" : !cfg["restore.terminals"] ? "dropped: restore.terminals is off" : !space ? "dropped: its Space is closed" : null;
    if (drop || !space) {
      count(drop ?? "dropped", rec.id);
      panes.discard(rec.id);
      continue;
    }
    const agent = hosted.get(rec.id);
    const resume = agent ? agents.resumeOfStored(agent) : null;
    const auto = !!resume && cfg["restore.resumeAgents"];
    const prefill = auto ? null : (resume ?? rec.command);
    // A resumed agent shows its conversation itself.
    const screen = auto ? null : store.screen(rec.id);
    const env: Record<string, string> = {};
    if (auto) {
      env[ENV.agentId] = agent!.id;
      if (agent!.parentId) env[ENV.parentId] = agent!.parentId;
    }
    if (prefill) env[RESTORE_COMMAND_ENV] = prefill;
    try {
      panes.create({
        id: rec.id,
        spaceId: space.id,
        cwd: isDir(rec.cwd) ? rec.cwd : space.root,
        cols: rec.cols,
        rows: rec.rows,
        env,
        command: auto ? resume! : undefined,
        replay: restoredText(screen, prefill),
        restored: rec,
      });
      back.set(rec.id, false);
      if (auto) resumed.set(rec.id, agent!.id);
      count(auto ? "resurrected, agent resumed" : prefill ? "resurrected, command offered" : "resurrected", rec.id, {
        screenBytes: screen?.data.length ?? 0,
        // An agent whose session can't be resumed: no session id yet, or no transcript on disk.
        agent: agent && !resume ? `${agent.kind}, not resumable (session ${sessionIdOf(agent) ? "without a transcript" : "unknown"})` : undefined,
      });
    } catch (err) {
      count("failed", rec.id);
      log.warn(`could not restore pane ${rec.id.slice(0, 8)}: ${(err as Error).message}`);
      panes.discard(rec.id);
    }
  }

  // Parents before children, so trees are rebuilt as they were.
  const alive = new Set<string>();
  for (const a of [...stored].sort((x, y) => x.depth - y.depth)) {
    const live = a.paneId ? back.get(a.paneId) : undefined;
    const keep = a.paneId
      ? live === true || resumed.get(a.paneId) === a.id
      : // A virtual child (a subagent) lives in its parent's process: only if that kept running.
        !!a.parentId && alive.has(a.parentId) && back.get(stored.find((p) => p.id === a.parentId)?.paneId ?? "") === true;
    if (!keep) {
      count("agent dropped", a.id, { kind: a.kind, virtual: !a.paneId });
      store.deleteAgent(a.id);
      continue;
    }
    agents.restore(a, live !== false);
    alive.add(a.id);
  }
  tally.agents = alive.size;
  if (Object.keys(tally).length > 1 || alive.size) log.info("restored the last session", { backend: backend.info ? `PTY host ${backend.info().pid}` : "in the core", ...tally });
}

/** The old screen, then a dim line saying it was restored (and what ran). */
function restoredText(screen: { data: string; savedAt: number } | null, command: string | null): string {
  const when = screen ? ` · ${new Date(screen.savedAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : "";
  const ran = command ? ` · was running: ${command.split("\n")[0]!.slice(0, 200)}` : "";
  const line = `\x1b[0m\x1b[2m── Restored${when}${ran} ──\x1b[0m\r\n`;
  return screen ? `${screen.data}\x1b[0m\r\n${line}` : line;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

