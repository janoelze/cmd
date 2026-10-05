// Notifications: one path for every source. Agents (needs input, finished a
// turn), terminal bells, notifications programs ask for (OSC 9/777/99), long
// commands finishing (OSC 133 from the shell integration), `cmd notify` and
// widgets (data.ts notify(), via MagicService), session summaries when written.
//
// The core decides what is worth telling, from the notifications.* settings and
// the terminal's mute; it sets the terminal's attention marker and emits an
// AppNotification. The UI decides whether to show it, since it knows focus and
// selection (notifications.when), and how (sound, Dock bounce, visual bell).
// Looking at the terminal clears its marker (pane.clearAttention).

import { EventEmitter } from "node:events";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { Agent, AppNotification, Attention, Pane, PaneId, Settings, WindowId } from "@cmd/protocol";
import type { OscEvent } from "./osc.ts";
import type { PaneManager } from "./panes.ts";
import type { AgentTracker } from "./agents/tracker.ts";

/** Bells closer together than this in one terminal count as one (a held key, a noisy script). */
const BELL_EVERY_MS = 2000;
/** Exit status of a command stopped with ⌃C: you were there, no need to tell you. */
const INTERRUPTED = 130;

interface Running {
  startedAt: number;
  /** The command's process, from the foreground polls while it runs. */
  name: string;
  /** An agent ran in it: the agent's own state says when it's done. */
  agent: boolean;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

const tildify = (p: string) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);
const cleanTitle = (t: string) => t.replace(/^[\s✳✻✽✶✢·•*◐◑◒◓⠀-⣿]+/u, "").trim();

export class NotificationCenter extends EventEmitter<{ notification: [AppNotification] }> {
  #panes: PaneManager;
  #settings: () => Settings;
  #agentStates = new Map<string, Agent["state"]>();
  #lastBell = new Map<PaneId, number>();
  #running = new Map<PaneId, Running>();

  constructor(panes: PaneManager, agents: AgentTracker, settings: () => Settings) {
    super();
    this.#panes = panes;
    this.#settings = settings;
    panes.on("osc", (id, ev) => this.#onOsc(id, ev));
    panes.on("foreground", (id, fg) => {
      const r = this.#running.get(id);
      if (!r) return;
      if (fg.class.kind === "agent") r.agent = true;
      else if (fg.class.kind === "other") r.name = fg.name;
    });
    panes.on("removed", (id) => {
      this.#lastBell.delete(id);
      this.#running.delete(id);
    });
    agents.on("updated", (a) => this.#onAgent(a));
    // An agent that needed you before a core restart was already announced.
    agents.on("restored", (a) => this.#agentStates.set(a.id, a.state));
    agents.on("removed", (id) => this.#agentStates.delete(id));
  }

  /** `cmd notify`: from a terminal (marks it) or from anywhere. */
  send(paneId: PaneId | null, title: string | undefined, body: string): void {
    const pane = paneId ? this.#panes.get(paneId) : null;
    if (!pane) {
      this.#emit({ source: "cli", paneId: null, title: title || "cmd", body, alert: true, urgent: true });
      return;
    }
    this.#mark(pane, { kind: "notify", text: body || title || "Notification", urgent: true });
    this.#emit({ source: "cli", paneId: pane.id, title: title || label(pane), body, alert: !pane.muted, urgent: true });
  }

  /** Something cmd did by itself that the user should know about (not urgent, no terminal). */
  info(title: string, body: string): void {
    this.#emit({ source: "cli", paneId: null, title, body, alert: true, urgent: false });
  }

  /** A widget's notification (MagicService keeps the window's attention marker). */
  widget(n: { windowId: WindowId; title: string; body: string; urgent: boolean; muted: boolean }): void {
    if (!this.#settings()["notifications.widgets"]) return;
    this.#emit({ source: "widget", paneId: null, windowId: n.windowId, title: n.title, body: n.body, alert: !n.muted, urgent: n.urgent });
  }

  clearAttention(paneId: PaneId): void {
    this.#panes.setAttention(paneId, null);
  }

  setMuted(paneId: PaneId, muted: boolean): void {
    this.#panes.setMuted(paneId, muted);
  }

  // ── sources ─────────────────────────────────────────────

  #onAgent(a: Agent): void {
    const prev = this.#agentStates.get(a.id);
    this.#agentStates.set(a.id, a.state);
    const needy = a.state === "needs_input" && prev !== "needs_input";
    const finished = a.state === "done" && prev === "working";
    if (!needy && !finished) return;
    const cfg = this.#settings();
    if ((needy && !cfg["notifications.needsInput"]) || (finished && !cfg["notifications.done"])) return;
    const pane = a.paneId ? this.#panes.get(a.paneId) : null;
    const name = a.name ?? a.spawn.prompt ?? a.kind;
    // The agent's light is its marker; no attention marker on the pane.
    this.#emit({
      source: needy ? "agent-input" : "agent-done",
      paneId: a.paneId,
      title: needy ? `${name} needs you` : `${name} is done`,
      body: needy ? (a.detail ?? "") : (a.lastMessage ?? "").slice(0, 200),
      alert: !pane?.muted,
      urgent: needy,
    });
  }

  #onOsc(id: PaneId, ev: OscEvent): void {
    const pane = this.#panes.get(id);
    if (!pane) return;
    const cfg = this.#settings();
    switch (ev.type) {
      case "bell": {
        // An agent's bell means "needs you" or "done", which its state already says.
        if (pane.agentId || cfg["notifications.bell"] === "ignore") return;
        const now = Date.now();
        if (now - (this.#lastBell.get(id) ?? 0) < BELL_EVERY_MS) return;
        this.#lastBell.set(id, now);
        this.#mark(pane, { kind: "bell", text: "Bell", urgent: true });
        // Always emitted (the UI flashes the window); alert only when asked for.
        const alert = cfg["notifications.bell"] === "notify" && !pane.muted;
        this.#emit({ source: "bell", paneId: id, title: label(pane), body: "Bell", alert, urgent: true });
        return;
      }
      case "notify": {
        // An agent's notifications become its state (agents/tracker.ts), so they aren't shown twice.
        if (pane.agentId || !cfg["notifications.terminalSequences"]) return;
        const text = ev.body || ev.title;
        if (!text) return;
        this.#mark(pane, { kind: "notify", text, urgent: true });
        this.#emit({
          source: "terminal",
          paneId: id,
          title: ev.body ? ev.title || label(pane) : label(pane),
          body: text,
          alert: !pane.muted,
          urgent: true,
        });
        return;
      }
      case "prompt": {
        if (ev.mark === "C") {
          this.#running.set(id, { startedAt: Date.now(), name: "", agent: !!pane.agentId });
          return;
        }
        if (ev.mark !== "D") return;
        const run = this.#running.get(id);
        this.#running.delete(id);
        const min = cfg["notifications.longCommand"];
        if (!run || run.agent || min <= 0 || ev.exitCode === INTERRUPTED) return;
        const took = Date.now() - run.startedAt;
        if (took < min * 1000) return;
        const failed = ev.exitCode !== undefined && ev.exitCode !== 0;
        const name = run.name || "Command";
        const verdict = failed ? `failed (exit ${ev.exitCode})` : "finished";
        this.#mark(pane, { kind: "command", text: `${name} ${verdict} · ${formatDuration(took)}`, urgent: failed });
        this.#emit({
          source: "command",
          paneId: id,
          title: `${name} ${verdict}`,
          body: `after ${formatDuration(took)} in ${tildify(pane.cwd)}`,
          alert: !pane.muted,
          urgent: failed,
        });
        return;
      }
    }
  }

  /** News about a window cmd made for you (a session summary is written); clicking it shows the window. */
  window(windowId: WindowId, source: "summary", title: string, body: string): void {
    this.#emit({ source, paneId: null, windowId, title, body, alert: true, urgent: false });
  }

  #mark(pane: Pane, a: Omit<Attention, "at">): void {
    this.#panes.setAttention(pane.id, { ...a, at: Date.now() });
  }

  #emit(n: Omit<AppNotification, "id">): void {
    this.emit("notification", { id: randomUUID(), ...n });
  }
}

/** What to call a terminal in a notification: its title, else its process. */
function label(pane: Pane): string {
  const t = cleanTitle(pane.title);
  return t && t !== pane.shell.split("/").pop() ? t : pane.foreground || "Terminal";
}
