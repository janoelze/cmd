// The phone's screens (prototype; docs/13-remote-access.md, "Experience"):
// pairing from the link, then Now (what needs you, what's working, what just
// finished, the other terminals, across Spaces) and a terminal per row. States
// say what's going on in words: connecting, offline since…, not paired anymore.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { bucketOf, type Agent, type CoreEvent, type Pane, type Space } from "@cmd/protocol";
import { Connection, pair, type Phase } from "./connection.ts";
import { forgetIdentity, loadIdentity, type Identity } from "./identity.ts";
import { TerminalScreen } from "./Terminal.tsx";

type Boot = { kind: "loading" } | { kind: "welcome" } | { kind: "pairing"; words: string[] | null; error: string | null } | { kind: "paired"; conn: Connection };

export function App() {
  const [boot, setBoot] = useState<Boot>({ kind: "loading" });

  useEffect(() => {
    const fragment = location.pathname.endsWith("/pair") ? location.hash : "";
    if (fragment.length > 1) {
      // The fragment holds a one-time key: out of the address bar and history at once.
      history.replaceState(null, "", "/");
      setBoot({ kind: "pairing", words: null, error: null });
      pair(fragment, (words) => setBoot({ kind: "pairing", words, error: null })).then(
        (id) => setBoot({ kind: "paired", conn: start(id) }),
        (err: Error) => setBoot({ kind: "pairing", words: null, error: err.message }),
      );
      return;
    }
    void loadIdentity().then((id) => setBoot(id ? { kind: "paired", conn: start(id) } : { kind: "welcome" }));
  }, []);

  switch (boot.kind) {
    case "loading":
      return <Center title="cmd" />;
    case "welcome":
      return (
        <Center title="Not paired yet">
          On your Mac, open cmd → Settings → Remote Access and scan the code with this phone's camera.
        </Center>
      );
    case "pairing":
      if (boot.error) return <Center title="Couldn't pair">{boot.error}</Center>;
      if (!boot.words) return <Center title="Pairing…" />;
      return (
        <Center title="Approve on your Mac">
          Check that your Mac shows these words:
          <div className="words">
            {boot.words.map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </div>
        </Center>
      );
    case "paired":
      return <Paired conn={boot.conn} />;
  }
}

function start(id: Identity): Connection {
  const conn = new Connection(id);
  conn.start();
  return conn;
}

function usePhase(conn: Connection): Phase {
  return useSyncExternalStore(
    (fn) => conn.onChange(fn),
    () => conn.phase,
  );
}

function Paired({ conn }: { conn: Connection }) {
  const phase = usePhase(conn);
  const model = useModel(conn, phase);
  const [open, setOpen] = useState<string | null>(null);

  if (phase.kind === "refused")
    return (
      <Center title="Not paired anymore">
        Your Mac doesn't know this browser now. Pair again from cmd → Settings → Remote Access.
        <button className="btn" onClick={() => void forgetIdentity().then(() => location.reload())}>
          Forget This Mac
        </button>
      </Center>
    );
  if (!model) return <Center title={phase.kind === "offline" ? "Your Mac is offline" : "Connecting…"}>{phase.kind === "offline" ? offlineText(phase) : null}</Center>;

  const control = model.scope === "control";
  const pane = open ? model.panes.get(open) : undefined;
  return (
    <div className="app">
      <header className="bar">
        {pane ? (
          <button className="back" onClick={() => setOpen(null)}>
            ‹ Now
          </button>
        ) : (
          <span className="title">Now</span>
        )}
        <span className={`pill ${phase.kind}`}>{phase.kind === "online" ? (control ? "Connected" : "Connected · view only") : phase.kind === "offline" ? "Offline" : "Connecting…"}</span>
      </header>
      {phase.kind === "offline" && <div className="banner">{offlineText(phase)}</div>}
      {pane ? (
        <TerminalScreen key={pane.id} conn={conn} pane={pane} control={control} />
      ) : (
        <Now model={model} onOpen={(id) => {
          setOpen(id);
          const a = [...model.agents.values()].find((x) => x.paneId === id);
          if (a && bucketOf(a) !== "rest") void conn.client?.call("agent.markSeen", { agentId: a.id }).catch(() => {});
          if (model.panes.get(id)?.attention) void conn.client?.call("pane.clearAttention", { paneId: id }).catch(() => {});
        }} />
      )}
    </div>
  );
}

const offlineText = (p: Extract<Phase, { kind: "offline" }>) =>
  `${p.reason === "mac" ? "Your Mac is offline. It may be asleep, or remote access is off." : "Can't reach your Mac."} Since ${new Date(p.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Retrying…`;

// ── model ──────────────────────────────────────────────

interface Model {
  panes: Map<string, Pane>;
  agents: Map<string, Agent>;
  spaces: Map<string, Space>;
  scope: "view" | "control";
}

/** The bootstrap, kept current by events. Stays (stale) while offline. */
function useModel(conn: Connection, phase: Phase): Model | null {
  const [model, setModel] = useState<Model | null>(null);
  useEffect(() => {
    if (phase.kind !== "online") return;
    const b = phase.boot;
    setModel({
      panes: new Map(b.panes.map((p) => [p.id, p])),
      agents: new Map(b.agents.map((a) => [a.id, a])),
      spaces: new Map(b.spaces.map((s) => [s.id, s])),
      scope: b.device?.scope ?? "view",
    });
  }, [phase]);
  useEffect(
    () =>
      conn.onEvent((e: CoreEvent) =>
        setModel((m) => {
          if (!m) return m;
          const next = { ...m };
          if (e.type === "pane.updated") next.panes = new Map(m.panes).set(e.pane.id, e.pane);
          else if (e.type === "pane.removed") (next.panes = new Map(m.panes)).delete(e.paneId);
          else if (e.type === "agent.updated") next.agents = new Map(m.agents).set(e.agent.id, e.agent);
          else if (e.type === "agent.removed") (next.agents = new Map(m.agents)).delete(e.agentId);
          else if (e.type === "space.updated") next.spaces = new Map(m.spaces).set(e.space.id, e.space);
          else if (e.type === "space.removed") (next.spaces = new Map(m.spaces)).delete(e.id);
          else return m;
          return next;
        }),
      ),
    [conn],
  );
  return model;
}

// ── Now ────────────────────────────────────────────────

interface Item {
  paneId: string;
  title: string;
  space: string;
  detail: string | null;
  since: number;
}

function Now({ model, onOpen }: { model: Model; onOpen: (paneId: string) => void }) {
  const sections = useMemo(() => {
    const needs: Item[] = [];
    const working: Item[] = [];
    const done: Item[] = [];
    const other: Item[] = [];
    const spaceName = (id: string) => model.spaces.get(id)?.name ?? "";
    for (const pane of model.panes.values()) {
      const a = pane.agentId ? model.agents.get(pane.agentId) : undefined;
      const item: Item = {
        paneId: pane.id,
        title: a?.name ?? (a ? `${a.kind} · ${pane.title}` : pane.title),
        space: spaceName(pane.spaceId),
        detail: a?.detail ?? firstLine(a?.lastMessage) ?? (pane.attention ? "Wants you" : pane.foreground !== "zsh" && pane.foreground !== "bash" ? pane.foreground : null),
        since: a?.stateSince ?? pane.lastActivityAt,
      };
      if (a?.state === "needs_input" || (!a && pane.attention)) needs.push(item);
      else if (a && (a.state === "working" || a.state === "starting")) working.push(item);
      else if (a && bucketOf(a) === "unseen") done.push(item);
      else other.push(item);
    }
    const oldest = (x: Item[]) => x.sort((p, q) => p.since - q.since);
    const newest = (x: Item[]) => x.sort((p, q) => q.since - p.since);
    return [
      { title: "Needs you", items: oldest(needs) },
      { title: "Working", items: newest(working) },
      { title: "Done", items: newest(done) },
      { title: "Terminals", items: newest(other) },
    ].filter((s) => s.items.length);
  }, [model]);

  if (!sections.length) return <Center title="Nothing running">Terminals and agents on your Mac show up here.</Center>;
  return (
    <main className="now">
      {sections.map((s) => (
        <section key={s.title}>
          <h2>{s.title}</h2>
          {s.items.map((it) => (
            <button key={it.paneId} className="row" onClick={() => onOpen(it.paneId)}>
              <span className="row-top">
                <span className="row-title">{it.title}</span>
                <span className="row-when">{ago(it.since)}</span>
              </span>
              <span className="row-sub">
                {it.space}
                {it.detail ? ` · ${it.detail}` : ""}
              </span>
            </button>
          ))}
        </section>
      ))}
    </main>
  );
}

const firstLine = (s: string | null | undefined) => s?.split("\n").find((l) => l.trim())?.slice(0, 140) ?? null;

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function Center({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="center">
      <h1>{title}</h1>
      {children && <div className="center-body">{children}</div>}
    </div>
  );
}
