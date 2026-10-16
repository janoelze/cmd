// The phone's screens (docs/13-remote-access.md, "Experience"): pairing, from
// the link or from the Mac's code scanned or pasted in Add a Mac (Pairing.tsx),
// then Now and a terminal per row, with the connection's state in words
// throughout (connecting, offline since…, not paired anymore). A browser can be
// paired with several Macs (identity.ts); it opens the one used last, and the
// settings sheet switches. A pairing link pairs only when the person says so,
// in every browser, and offers installing the app as the other choice (install.ts).
// Notifications (push.ts): asked for once on Now, switched in the settings
// sheet; while the page is open the Mac's notifications show as toasts, and a
// tapped one opens its Mac and terminal.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { bucketOf } from "@cmd/protocol";
import { Button, Callout, IconButton, StatusDot, Toaster, toast } from "@cmd/ui";
import { Connection, pair, type Phase } from "./connection.ts";
import { forgetIdentity, listMacs, loadIdentity, macKey, touchIdentity, type Identity, type Mac } from "./identity.ts";
import { itemOf, useModel } from "./model.ts";
import { Now } from "./Now.tsx";
import { disablePush, enablePush, forgetPush, onOpenRequest, openRequestFromUrl, pushState, type PushState } from "./push.ts";
import { AddMac, PairLink } from "./Pairing.tsx";
import { MacsSheet, Settings } from "./Settings.tsx";
import { TerminalScreen } from "./Terminal.tsx";
import { Center } from "./ui.tsx";

type Screen =
  | { kind: "loading" }
  /** Add a Mac; `back` is the Mac to return to on Cancel. */
  | { kind: "add"; back: Connection | null }
  /** A pairing link, held in memory until the person taps Pair This Browser. */
  | { kind: "link"; fragment: string }
  | { kind: "pairing"; words: string[] | null; error: string | null; back: Connection | null }
  /** pane: the terminal to open first (a tapped notification). */
  | { kind: "paired"; conn: Connection; n: number; pane: string | null };

let started = 0;

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });

  const current = useRef(screen);
  current.current = screen;

  const show = (id: Identity, pane: string | null = null) => {
    const conn = new Connection(id);
    conn.start();
    void touchIdentity(macKey(id.hostKey), { lastUsed: Date.now() }).catch(() => {});
    setScreen({ kind: "paired", conn, n: ++started, pane });
  };
  /** The Mac with this key (and its terminal), or, without one, the one used last; Add a Mac when there's none. */
  const open = async (key?: string, pane: string | null = null) => {
    const macs = await listMacs().catch(() => [] as Mac[]);
    for (const k of key ? [key, ...macs.map((m) => m.key)] : macs.map((m) => m.key)) {
      const id = await loadIdentity(k).catch(() => undefined);
      if (id) return show(id, k === key ? pane : null);
    }
    setScreen({ kind: "add", back: null });
  };
  const startPairing = (fragment: string, back: Connection | null) => {
    setScreen({ kind: "pairing", words: null, error: null, back });
    pair(fragment, (words) => setScreen({ kind: "pairing", words, error: null, back })).then(
      (id) => (back?.close(), show(id)),
      (err: Error) => setScreen({ kind: "pairing", words: null, error: err.message, back }),
    );
  };
  const forget = async (conn: Connection) => {
    await disablePush(conn).catch(() => {});
    conn.close();
    await forgetPush(conn.key).catch(() => {});
    await forgetIdentity(conn.key).catch(() => {});
    await open();
  };
  const switchTo = (conn: Connection, key: string) => {
    if (key === conn.key) return;
    conn.close();
    void open(key);
  };

  useEffect(() => {
    const fragment = location.pathname.endsWith("/pair") ? location.hash : "";
    if (fragment.length > 1) {
      // The fragment holds a one-time key: out of the address bar and history at once.
      history.replaceState(null, "", "/");
      // Never on load: the key is single use, and this browser may not be where the person wants cmd.
      setScreen({ kind: "link", fragment });
      return;
    }
    const req = openRequestFromUrl();
    void open(req?.mac, req?.paneId ?? null);
  }, []);

  // A notification tapped while this page is open: its Mac, at its terminal. Never in the middle of pairing.
  useEffect(
    () =>
      onOpenRequest((r) => {
        const s = current.current;
        if (s.kind === "paired" && s.conn.key === r.mac) setScreen({ ...s, n: ++started, pane: r.paneId });
        else if (s.kind === "paired") (s.conn.close(), void open(r.mac, r.paneId));
        else if (s.kind === "loading" || s.kind === "add") void open(r.mac, r.paneId);
      }),
    [],
  );

  switch (screen.kind) {
    case "loading":
      return <Center icon="terminal" title="cmd" />;
    case "add": {
      const back = screen.back;
      return (
        <AddMac
          title={back ? "Add a Mac" : "Pair with Your Mac"}
          onPair={(f) => startPairing(f, back)}
          onCancel={back ? () => setScreen({ kind: "paired", conn: back, n: ++started, pane: null }) : undefined}
        />
      );
    }
    case "link":
      return <PairLink onPair={() => startPairing(screen.fragment, null)} />;
    case "pairing": {
      const back = screen.back;
      if (screen.error)
        return (
          <Center
            icon="xmark.octagon"
            title="Couldn't pair"
            action={
              <Button size="lg" variant="primary" icon="qrcode.viewfinder" onClick={() => setScreen({ kind: "add", back })}>
                Scan Again
              </Button>
            }
          >
            {screen.error}
          </Center>
        );
      if (!screen.words) return <Center icon="lock" title="Pairing…" />;
      return (
        <Center icon="lock" title="Approve on your Mac">
          Check that your Mac shows these words:
          <div className="words">
            {screen.words.map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </div>
        </Center>
      );
    }
    case "paired": {
      const conn = screen.conn;
      return (
        <Paired
          key={screen.n}
          conn={conn}
          pane={screen.pane}
          onAdd={() => setScreen({ kind: "add", back: conn })}
          onSwitch={(key) => switchTo(conn, key)}
          onForget={() => void forget(conn)}
        />
      );
    }
  }
}

function usePhase(conn: Connection): Phase {
  return useSyncExternalStore(
    (fn) => conn.onChange(fn),
    () => conn.phase,
  );
}

interface MacActions {
  onAdd: () => void;
  onSwitch: (key: string) => void;
  onForget: () => void;
}

function Paired({ conn, pane: first, onAdd, onSwitch, onForget }: { conn: Connection; pane: string | null } & MacActions) {
  const phase = usePhase(conn);
  const model = useModel(conn);
  const [open, setOpen] = useState<string | null>(first);
  const push = usePush(conn, phase);
  // For the toasts: the terminal on screen, and how to open one (it needs the model).
  const shown = useRef(open);
  shown.current = open;
  const openRef = useRef<(id: string) => void>(setOpen);

  // The terminal on screen is in the address (the form a notification's link has, push.ts), so a reload
  // (iOS reloads background tabs and Home Screen apps on its own) lands on it again. Replaced, never
  // added: the Home Screen app has no Back, and Now is this screen's own back.
  useEffect(() => {
    history.replaceState(null, "", open ? `/?${new URLSearchParams({ mac: conn.key, pane: open })}` : "/");
  }, [open, conn.key]);
  // Gone by the time the Mac answers (closed meanwhile): Now, quietly.
  useEffect(() => {
    if (model && open && !model.panes.has(open)) setOpen(null);
  }, [model, open]);

  // The Mac's notifications while this page is open: a toast, unless it's about the terminal on screen.
  useEffect(
    () =>
      conn.onEvent((e) => {
        if (e.type !== "notification" || !e.notification.alert) return;
        const n = e.notification;
        if (n.paneId && n.paneId === shown.current) return;
        const paneId = n.paneId;
        toast(
          <>
            <strong>{n.title}</strong> {n.body}
          </>,
          { icon: "bell", duration: n.urgent ? 8000 : 4000, action: paneId ? { label: "Open", run: () => openRef.current(paneId) } : undefined },
        );
      }),
    [conn],
  );
  // Still not through after a few seconds: offer to try now rather than wait for the next attempt.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (model) return setSlow(false);
    const t = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(t);
  }, [model, phase.kind]);
  const tryAgain = slow && (
    <Button size="lg" onClick={() => (setSlow(false), conn.retry())}>
      Try Again
    </Button>
  );
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [macs, setMacs] = useState(false);
  const actions = { onAdd, onSwitch, onForget };

  // Before the Mac answers there's no settings sheet, but switching to another Mac still works.
  const others = <MacsSheet open={macs} current={conn.key} currentName={conn.identity.name} onAdd={onAdd} onSwitch={onSwitch} onClose={() => setMacs(false)} />;
  const switchMac = (
    <Button size="lg" variant="ghost" onClick={() => setMacs(true)}>
      Switch Mac
    </Button>
  );

  if (phase.kind === "refused")
    return (
      <>
        <Center
          icon="lock"
          title="Not paired anymore"
          action={
            <>
              <Button size="lg" onClick={() => conn.retry()}>
                Try Again
              </Button>
              <Button size="lg" variant="ghost" onClick={onForget}>
                Forget This Mac
              </Button>
              {switchMac}
            </>
          }
        >
          Your Mac doesn't know this browser now. Pair again from cmd → Settings → Remote Access.
        </Center>
        {others}
      </>
    );
  if (!model)
    return (
      <>
        {phase.kind === "offline" ? (
          <Center
            icon="wifi.slash"
            title={`${conn.identity.name ?? "Your Mac"} is offline`}
            action={
              <>
                {tryAgain}
                {switchMac}
              </>
            }
          >
            {offlineText(phase)}
          </Center>
        ) : (
          <Center icon="terminal" title="Connecting…" action={tryAgain || undefined} />
        )}
        {others}
      </>
    );

  const pane = open ? model.panes.get(open) : undefined;
  const openPane = (id: string) => {
    setOpen(id);
    const p = model.panes.get(id);
    const a = p?.agentId ? model.agents.get(p.agentId) : undefined;
    if (a && bucketOf(a) !== "rest") void conn.client?.call("agent.markSeen", { agentId: a.id }).catch(() => {});
    if (p?.attention) void conn.client?.call("pane.clearAttention", { paneId: id }).catch(() => {});
  };
  openRef.current = openPane;

  return (
    <div className="app">
      {pane ? (
        <TerminalScreen key={pane.id} conn={conn} item={itemOf(model, pane)} control={model.scope === "control"} onBack={() => setOpen(null)} />
      ) : (
        <>
          <header className="bar">
            <div className="bar-title">
              <h1>Now</h1>
              <span className="status">
                <StatusDot state={phase.kind === "online" ? "success" : phase.kind === "offline" ? "warning" : "off"} size="sm" /> {model.host}
              </span>
            </div>
            <IconButton icon="gearshape" size="lg" label="Settings" onClick={() => setSettings(true)} />
          </header>
          {phase.kind === "offline" && (
            <Callout tone="warning" banner>
              {offlineText(phase)}
            </Callout>
          )}
          {push.ask && (
            <Callout
              icon="bell"
              banner
              title="Get notified on this device"
              actions={
                <>
                  <Button variant="primary" onClick={() => void push.set(true)}>
                    Turn On
                  </Button>
                  <Button variant="ghost" onClick={push.dismiss}>
                    Not Now
                  </Button>
                </>
              }
            >
              Know when an agent needs you, even with cmd closed.
            </Callout>
          )}
          <Now conn={conn} model={model} workspaceId={workspaceId} onWorkspace={setWorkspaceId} onOpen={openPane} />
        </>
      )}
      {pane && phase.kind === "offline" && (
        <div className="floating">
          <Callout tone="warning">{offlineText(phase)}</Callout>
        </div>
      )}
      <Settings open={settings} conn={conn} phase={phase} model={model} push={push.state} onPush={(on) => void push.set(on)} {...actions} onClose={() => setSettings(false)} />
      <Toaster />
    </div>
  );
}

const offlineText = (p: Extract<Phase, { kind: "offline" }>) =>
  `${p.reason === "mac" ? "It may be asleep, or remote access is off." : p.reason === "busy" ? "It's busy right now." : "Can't reach it right now."} Since ${new Date(p.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Retrying…`;

/** Don't ask again on Now for this Mac (per browser; Settings still switches it). */
const askedKey = (mac: string) => `cmd.push.asked.${mac}`;
function asked(mac: string): boolean {
  try {
    return localStorage.getItem(askedKey(mac)) !== null;
  } catch {
    return false;
  }
}

/** This device's notifications from this Mac: their state, switching them, and whether Now asks. */
function usePush(conn: Connection, phase: Phase) {
  const [state, setState] = useState<PushState | null>(null);
  const [dismissed, setDismissed] = useState(() => asked(conn.key));
  const boot = phase.kind === "online" ? phase.boot : null;
  useEffect(() => {
    if (!boot) return;
    let live = true;
    void pushState(conn.key, boot.push).then((s) => live && setState(s), () => live && setState("unsupported"));
    return () => void (live = false);
  }, [conn, boot]);
  const dismiss = () => {
    try {
      localStorage.setItem(askedKey(conn.key), String(Date.now()));
    } catch {
      // private mode: asks again next time
    }
    setDismissed(true);
  };
  const set = async (on: boolean) => {
    dismiss();
    if (!boot?.push) return;
    try {
      if (on) setState(await enablePush(conn, boot.push));
      else (await disablePush(conn), setState("off"));
    } catch (err) {
      setState(await pushState(conn.key, boot.push).catch(() => "unsupported" as const));
      console.warn(`notifications: ${(err as Error).message}`);
      toast(on ? "Couldn't turn on notifications. Try again, or check this browser's notification settings." : "Couldn't turn off notifications. Try again.", { tone: "danger" });
    }
  };
  // Asked once, where it can work: never in an iOS tab (Add to Home Screen first) or once blocked.
  const ask = state === "off" && !dismissed && typeof Notification !== "undefined" && Notification.permission === "default";
  return { state, ask, set, dismiss };
}
