// The phone's screens (docs/13-remote-access.md, "Experience"): pairing from
// the link, then Now and a terminal per row, with the connection's state in
// words throughout (connecting, offline since…, not paired anymore).

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { bucketOf } from "@cmd/protocol";
import { Connection, pair, type Phase } from "./connection.ts";
import { forgetIdentity, loadIdentity, type Identity } from "./identity.ts";
import { itemOf, useModel } from "./model.ts";
import { Now } from "./Now.tsx";
import { Settings } from "./Settings.tsx";
import { TerminalScreen } from "./Terminal.tsx";
import { Icon } from "./ui.tsx";

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
      return <Center icon="terminal" title="cmd" />;
    case "welcome":
      return (
        <Center icon="terminal" title="Not paired yet">
          On your Mac, open cmd → Settings → Remote Access and scan the code with this phone's camera.
        </Center>
      );
    case "pairing":
      if (boot.error) return <Center icon="close" title="Couldn't pair">{boot.error}</Center>;
      if (!boot.words) return <Center icon="lock" title="Pairing…" />;
      return (
        <Center icon="lock" title="Approve on your Mac">
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
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);

  if (phase.kind === "refused")
    return (
      <Center icon="lock" title="Not paired anymore">
        Your Mac doesn't know this browser now. Pair again from cmd → Settings → Remote Access.
        <button className="btn" onClick={() => void forgetIdentity().then(() => location.reload())}>
          Forget This Mac
        </button>
      </Center>
    );
  if (!model)
    return phase.kind === "offline" ? (
      <Center icon="offline" title="Your Mac is offline">
        {offlineText(phase)}
      </Center>
    ) : (
      <Center icon="terminal" title="Connecting…" />
    );

  const pane = open ? model.panes.get(open) : undefined;
  const openPane = (id: string) => {
    setOpen(id);
    const p = model.panes.get(id);
    const a = p?.agentId ? model.agents.get(p.agentId) : undefined;
    if (a && bucketOf(a) !== "rest") void conn.client?.call("agent.markSeen", { agentId: a.id }).catch(() => {});
    if (p?.attention) void conn.client?.call("pane.clearAttention", { paneId: id }).catch(() => {});
  };

  return (
    <div className="app">
      {pane ? (
        <TerminalScreen key={pane.id} conn={conn} item={itemOf(model, pane)} control={model.scope === "control"} onBack={() => setOpen(null)} />
      ) : (
        <>
          <header className="bar">
            <div className="bar-title">
              <h1>Now</h1>
              <span className={`status ${phase.kind}`}>
                <span className="status-dot" /> {model.host}
              </span>
            </div>
            <button className="icon-btn" onClick={() => setSettings(true)} aria-label="Settings">
              <Icon name="settings" size={22} />
            </button>
          </header>
          {phase.kind === "offline" && <div className="banner">{offlineText(phase)}</div>}
          <Now conn={conn} model={model} workspaceId={workspaceId} onWorkspace={setWorkspaceId} onOpen={openPane} />
        </>
      )}
      {pane && phase.kind === "offline" && <div className="banner floating">{offlineText(phase)}</div>}
      {settings && <Settings conn={conn} phase={phase} model={model} onClose={() => setSettings(false)} />}
    </div>
  );
}

const offlineText = (p: Extract<Phase, { kind: "offline" }>) =>
  `${p.reason === "mac" ? "It may be asleep, or remote access is off." : "Can't reach it right now."} Since ${new Date(p.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Retrying…`;

function Center({ icon, title, children }: { icon: Parameters<typeof Icon>[0]["name"]; title: string; children?: ReactNode }) {
  return (
    <div className="center">
      <div className="center-icon">
        <Icon name={icon} size={28} />
      </div>
      <h1>{title}</h1>
      {children && <div className="center-body">{children}</div>}
    </div>
  );
}
