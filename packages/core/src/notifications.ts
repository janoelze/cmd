// Notifications: one path for every source. Agents (needs input, finished a
// turn), terminal bells, notifications programs ask for (OSC 9/777/99), long
// commands finishing (OSC 133 from the shell integration), `cmd notify` and
// widgets (data.ts notify(), via MagicService), session summaries when written.
//
// The core decides what is worth telling, from the notifications.* settings and
// the terminal's mute; it sets the terminal's attention marker and emits an
// AppNotification. The UI decides whether to show it, since it knows focus and
// selection (notifications.when), and how (sound, Dock bounce, visual bell).
// A turn you prompted that ends within QUICK_TURN_MS isn't news; the UI also
// drops a "done" you saw happen and sums up agents finishing together
// (renderer/src/notify.ts). Looking at the terminal clears its marker
// (pane.clearAttention). Every notification is an event in the log
// (data/recorders.ts), with the Space of what it is about; the Notifications
// widget is a live query over them.

import { EventEmitter } from "node:events";
import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Agent, AppNotification, Attention, Pane, PaneId, Settings, SpaceId, WindowId } from "@cmd/protocol";
import type { OscEvent } from "./osc.ts";
import type { PaneManager } from "./panes.ts";
import type { AgentTracker } from "./agents/tracker.ts";
import { agentNotice, subjectOf, type NoticeKind } from "./agents/notice.ts";

/** Writes an agent notification's body with AI; null: use cmd's own (agents/notice.ts). */
export type NoticeWriter = (a: Agent, kind: NoticeKind, signal: AbortSignal) => Promise<string | null>;

/** How long a notification waits for its AI wording before going out with cmd's own. */
export const AI_WAIT_MS = { needs: 1500, done: 2500, stopped: 2500 } as const;

/** A turn you prompted that finished quicker than this: you're still there, no "done". */
export const QUICK_TURN_MS = 20_000;

/** Shells that fail to start in a burst (several new terminals, a restore) get one notification. */
export const START_FAILURE_MS = 30_000;
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
  /** The Space a terminal or window is in, for the notifications about it (set by the core once windows exist). */
  spaceOf: (paneId: PaneId | null, windowId: WindowId | null) => SpaceId | null = () => null;
  #panes: PaneManager;
  #settings: () => Settings;
  #agentStates = new Map<string, Agent["state"]>();
  #lastBell = new Map<PaneId, number>();
  /** The last "couldn't start" notification: one per burst (opening several terminals, restoring). */
  #lastStartFailure = 0;
  #running = new Map<PaneId, Running>();

  #writer: NoticeWriter | null;
  #agents: AgentTracker;

  constructor(panes: PaneManager, agents: AgentTracker, settings: () => Settings, writer: NoticeWriter | null = null) {
    super();
    this.#panes = panes;
    this.#settings = settings;
    this.#writer = writer;
    this.#agents = agents;
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
    panes.on("failed", (_id, shell, message, cause) => this.#startFailed(shell, message, cause));
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

  /** A shell that couldn't start, once per START_FAILURE_MS: the window is gone, so this says why. */
  #startFailed(shell: string, message: string, cause: "ptys" | null): void {
    const now = Date.now();
    if (now - this.#lastStartFailure < START_FAILURE_MS) return;
    this.#lastStartFailure = now;
    const body =
      cause === "ptys"
        ? "macOS has no free pseudo-terminal left (it allows 511). Close terminals or sessions you no longer need."
        : `${path.basename(shell)} didn't start: ${message}`;
    this.#emit({ source: "terminal", paneId: null, title: cause === "ptys" ? "Terminals can't start" : "Terminal couldn't start", body, alert: true, urgent: true });
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

  /** The widget was cleared (the core records it in the log): tell the clients. */
  clearAttention(paneId: PaneId): void {
    this.#panes.setAttention(paneId, null);
  }

  setMuted(paneId: PaneId, muted: boolean): void {
    this.#panes.setMuted(paneId, muted);
  }

  // ── sources ─────────────────────────────────────────────

  /**
   * An agent that needs you, finished, or stopped on an error (the copywriting
   * skill: subject · state, then the agent's own words and what cmd checked;
   * agents/notice.ts). Done only after work (a Stop), so inferred endings and
   * answered questions stay quiet.
   */
  #onAgent(a: Agent): void {
    const prev = this.#agentStates.get(a.id);
    this.#agentStates.set(a.id, a.state);
    const needy = a.state === "needs_input" && prev !== "needs_input";
    const finished = a.state === "done" && (prev === "working" || prev === "needs_input");
    const stopped = a.state === "failed" && prev !== "failed";
    if (!needy && !finished && !stopped) return;
    const cfg = this.#settings();
    if ((needy && !cfg["notifications.needsInput"]) || (!needy && !cfg["notifications.done"])) return;
    if (finished && quick(a)) return;
    const kind: NoticeKind = needy ? "needs" : finished ? "done" : "stopped";
    const { title: first, body } = agentNotice(a, kind);
    const send = (text: string) => {
      const pane = a.paneId ? this.#panes.get(a.paneId) : null;
      // A name given while the wording was written is in the title (agents/naming.ts).
      const now = this.#agents.get(a.id);
      const title = now && now.name !== a.name ? agentNotice(now, kind).title : first;
      // The agent's light is its marker; no attention marker on the pane.
      this.#emit({ source: needy ? "agent-input" : "agent-done", paneId: a.paneId, title, body: text, alert: !pane?.muted, urgent: needy, ...(finished ? { done: subjectOf(a) } : {}) });
    };
    if (!this.#writer || !cfg["notifications.ai"]) return send(body);
    // AI wording, if it comes in time: a posted notification can't be changed.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), AI_WAIT_MS[kind]);
    void this.#writer(a, kind, ac.signal)
      .catch(() => null)
      .then((text) => {
        clearTimeout(timer);
        send(!ac.signal.aborted && text ? text : body);
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
  window(windowId: WindowId, source: "summary" | "timer", title: string, body: string): void {
    this.#emit({ source, paneId: null, windowId, title, body, alert: true, urgent: source === "timer" });
  }

  #mark(pane: Pane, a: Omit<Attention, "at">): void {
    this.#panes.setAttention(pane.id, { ...a, at: Date.now() });
  }

  #emit(n: Omit<AppNotification, "id" | "at">): void {
    const full: AppNotification = { id: randomUUID(), ...n, spaceId: this.spaceOf(n.paneId, n.windowId ?? null), at: Date.now() };
    this.emit("notification", full);
  }
}

/**
 * A turn you started (not the agent's own follow-up) that ended within
 * QUICK_TURN_MS. One whose prompt cmd didn't see began earlier than it knows.
 */
function quick(a: Agent): boolean {
  const t = a.turn;
  return !!t && !t.auto && t.prompt !== null && t.endedAt !== null && t.endedAt - t.startedAt < QUICK_TURN_MS;
}

/** What to call a terminal in a notification: its title, else its process. */
function label(pane: Pane): string {
  const t = cleanTitle(pane.title);
  return t && t !== pane.shell.split("/").pop() ? t : pane.foreground || "Terminal";
}
