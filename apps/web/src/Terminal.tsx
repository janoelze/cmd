// A terminal on the phone (docs/13, "Terminals on a phone"). The page never scrolls:
// the terminal fills what's left above the keyboard. It shows the Mac's terminal at
// the Mac's size, at a readable text size (the width when it fits, else it pans), with
// pinch, pan and double-tap (viewport.ts); opening or reading it never resizes it on
// the Mac. "Fit to This Phone" (the menu, control access) sizes the Mac's terminal to
// this screen while it's shown (pane.fitOverride), refitting as the keyboard opens and
// closes or the phone rotates; leaving, locking the phone or disconnecting gives the
// Mac its size back, and the Mac (someone types there) or another device can take it.
// Above it: the state line (what the agent is doing or asking, who sized it); below
// it a key row (sticky ctrl and alt, arrows that repeat) and a compose bar (Return
// after a pause, or not). The xterm lives as long as the screen: a reconnect resyncs
// into it (screen.ts).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, ButtonGroup, ConfirmDialog, Dialog, Icon, IconButton, JumpButton, ListRow, ListRowContent, ListRowEnd, ListRowIcon, Presence, StatusDot, TextField } from "@cmd/ui";
import { terminalColors, useTheme } from "@cmd/ui/themes";
import { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { Pane } from "@cmd/protocol";
import type { Connection } from "./connection.ts";
import { stateText, type Item } from "./model.ts";
import { Screen, type Size } from "./screen.ts";
import { Viewport, type ViewportState } from "./viewport.ts";
import { DEFAULT_FONT, MAX_FONT, MIN_FONT, clamp } from "./zoom.ts";
import { KEYS, Repeater, compose, modified } from "./keys.ts";

const FONT_KEY = "cmd.terminal.fontSize";

/** This browser's text size for terminals (Text Size in the menu); kept per browser, never on the Mac. */
function useTextSize(): [number, (n: number) => void] {
  const [size, setSize] = useState(() => {
    try {
      const n = Number(localStorage.getItem(FONT_KEY));
      return n ? clamp(n, MIN_FONT, MAX_FONT) : DEFAULT_FONT;
    } catch {
      return DEFAULT_FONT;
    }
  });
  const set = (n: number) => {
    const v = clamp(n, MIN_FONT, MAX_FONT);
    setSize(v);
    try {
      localStorage.setItem(FONT_KEY, String(v));
    } catch {}
  };
  return [size, set];
}

export interface TerminalScreenProps {
  conn: Connection;
  item: Item;
  control: boolean;
  onBack: () => void;
  /** Start with "Fit to This Phone" on (control access only); off by default: the Mac's size, scaled. */
  fit?: boolean;
}

export function TerminalScreen({ conn, item, control, onBack, fit = false }: TerminalScreenProps) {
  const pane: Pane = item.pane;
  const view = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<{ t: Terminal; screen: Screen; viewport: Viewport } | null>(null);
  const [text, setText] = useState("");
  /** This phone sizes the Mac's terminal (else: the Mac's size, scaled). */
  const [fitting, setFitting] = useState(fit && control);
  const fittingRef = useRef(fitting);
  fittingRef.current = fitting;
  /** We asked the Mac for a size and haven't released it. */
  const holding = useRef(false);
  /** The sizes we asked for since: the pane at another one, sized by a device, means someone else took it. */
  const asked = useRef<string[]>([]);
  /** The core confirmed our size (sizedBy set) since we asked: a null after that means the Mac took it back. */
  const confirmed = useRef(false);
  const [mods, setModsState] = useState({ ctrl: false, alt: false });
  const modsRef = useRef(mods);
  modsRef.current = mods;
  /** The ref at once too: a key tapped right after a modifier (before the render) still gets it. */
  const setMods = (m: { ctrl: boolean; alt: boolean }) => ((modsRef.current = m), setModsState(m));
  const [enter, setEnter] = useState(true);
  const [menu, setMenu] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [vs, setVs] = useState<ViewportState>({ atBottom: true, unread: false, selection: false, pans: false, font: 0 });
  const [textSize, setTextSize] = useTextSize();
  const theme = useTheme();
  const colors = terminalColors(theme);
  const client = conn.client;
  const clientRef = useRef(client);
  clientRef.current = client;
  const paneRef = useRef(pane);
  paneRef.current = pane;

  const call = (data: string) => clientRef.current?.call("pane.write", { paneId: pane.id, data }).catch(() => {});
  /** Keys typed or tapped; sticky ctrl and alt apply to the next one. */
  const write = (data: string) => {
    const m = modsRef.current;
    if (m.ctrl || m.alt) setMods({ ctrl: false, alt: false });
    void call(modified(data, m));
  };
  const writeRef = useRef(write);
  writeRef.current = write;

  const release = () => {
    if (holding.current) void clientRef.current?.call("pane.fitOverride", { paneId: pane.id, release: true }).catch(() => {});
    holding.current = false;
    confirmed.current = false;
    asked.current = [];
  };
  /** Fit mode: this size, here and (once a snapshot is parsed) on the Mac. */
  const tell = (size: Size) => {
    const x = term.current;
    if (!x || !fittingRef.current || document.visibilityState !== "visible") return;
    x.screen.resize(size, () => {
      const p = paneRef.current;
      if (holding.current && p.cols === size.cols && p.rows === size.rows) return;
      holding.current = true;
      asked.current = [...asked.current.slice(-4), `${size.cols}x${size.rows}`];
      void clientRef.current?.call("pane.fitOverride", { paneId: p.id, ...size }).catch(() => {});
    });
  };
  const tellRef = useRef(tell);
  tellRef.current = tell;

  // The terminal, for as long as this screen shows: reconnects resync into it.
  useEffect(() => {
    const t = new Terminal({
      cols: pane.cols,
      rows: pane.rows,
      fontSize: textSize,
      fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
      disableStdin: !control,
      scrollback: 5000,
      theme: terminalColors(theme),
      allowProposedApi: true,
    });
    t.loadAddon(new Unicode11Addon());
    t.unicode.activeVersion = "11";
    // A click with a mouse (or a trackpad); taps are viewport.ts's.
    t.loadAddon(new WebLinksAddon((_e, uri) => setLink(uri)));
    t.open(host.current!);
    const screen = new Screen(t);
    const viewport = new Viewport({
      view: view.current!,
      pan: host.current!,
      term: t,
      pref: textSize,
      onState: setVs,
      onLink: setLink,
      onFit: (size) => tellRef.current(size),
    });
    // Written at the snapshot's size; no resizing until it is parsed, then the size again.
    screen.onParsed = () => {
      viewport.replaying = false;
      if (!fittingRef.current) screen.resize({ cols: paneRef.current.cols, rows: paneRef.current.rows });
      viewport.layout();
    };
    term.current = { t, screen, viewport };
    if (control) t.onData((d) => writeRef.current(d));
    return () => {
      release();
      term.current = null;
      viewport.dispose();
      t.dispose();
    };
  }, [pane.id]);

  // The connection: follow this pane, its snapshot, then its output. A new connection
  // (a reconnect) asks again and carries on in the same terminal.
  useEffect(() => {
    const x = term.current;
    if (!x || !client) return;
    let live = true;
    const snapshot = async () => {
      x.screen.awaitSnapshot();
      const snap = await client.call("pane.snapshot", { paneId: pane.id }).catch(() => null);
      if (!live || !snap) return;
      // A resync replayed over what shows: a still copy stays on top until it's parsed and drawn, so it doesn't blink.
      const el = x.screen.shown ? x.t.element?.querySelector<HTMLElement>(".xterm-screen") : null;
      const still = el?.cloneNode(true) as HTMLElement | undefined;
      if (still && el) (still.classList.add("term-still"), (still.style.top = `${el.offsetTop}px`), (still.style.left = `${el.offsetLeft}px`), el.parentElement!.append(still));
      x.viewport.replaying = true;
      const drop = () => requestAnimationFrame(() => requestAnimationFrame(() => still?.remove()));
      if (x.screen.snapshot(snap)) x.t.write("", drop);
      else still?.remove();
    };
    const off = conn.onEvent((e) => {
      if (e.type === "pane.output" && e.paneId === pane.id) x.screen.output(e.data, e.seq);
      else if (e.type === "pane.resync" && e.paneId === pane.id) void snapshot();
    });
    void client.call("window.follow", { ids: [pane.id] }).then(snapshot, () => {});
    return () => {
      live = false;
      off();
      void client.call("window.follow", { ids: [] }).catch(() => {});
      // A session's override ends with it; a new one asks again (fit mode refits after its snapshot).
      holding.current = false;
      confirmed.current = false;
    };
  }, [conn, pane.id, client]);

  // The Mac's theme changed (or Auto followed the phone): repaint.
  useEffect(() => {
    if (term.current) term.current.t.options.theme = terminalColors(theme);
  }, [theme]);

  useEffect(() => term.current?.viewport.setPref(textSize), [textSize]);

  // Fit to This Phone, or the Mac's size scaled; and the Mac's size when it changes.
  useEffect(() => {
    const x = term.current;
    if (!x) return;
    if (!fitting) {
      release();
      x.screen.resize({ cols: pane.cols, rows: pane.rows });
    }
    x.viewport.setMode(fitting ? "fit" : "scaled");
    x.viewport.layout();
  }, [fitting, pane.cols, pane.rows]);

  // Locked or switched away: give the Mac its size back; refit on return.
  useEffect(() => {
    const vis = () => {
      if (document.visibilityState === "hidden") release();
      else term.current?.viewport.layout();
    };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, [client]);

  // The Mac took it back (someone typed there), or another device did: stop fitting until asked again.
  useEffect(() => {
    if (!holding.current) return;
    const mine = asked.current.includes(`${pane.cols}x${pane.rows}`);
    if (pane.sizedBy !== null && mine) confirmed.current = true;
    else if ((pane.sizedBy === null && confirmed.current) || (pane.sizedBy !== null && !mine && confirmed.current)) {
      holding.current = false;
      confirmed.current = false;
      asked.current = [];
      setFitting(false);
    }
  }, [pane.sizedBy, pane.cols, pane.rows]);

  const [sending, setSending] = useState(false);
  const submit = async () => {
    if (!text && !enter) return;
    const m = modsRef.current;
    if (m.ctrl || m.alt) setMods({ ctrl: false, alt: false });
    setText("");
    setSending(true);
    await compose(call, modified(text, m), enter);
    setSending(false);
  };
  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) void call(`\x1b[200~${t}\x1b[201~`);
    } catch {}
  };
  const copy = async () => {
    const x = term.current;
    const s = x?.t.getSelection();
    if (!s) return;
    try {
      await navigator.clipboard.writeText(s);
    } catch {}
    x!.viewport.clearSelection();
  };

  // Who has the size, kept in view when the line runs long.
  const sizedBy = fitting ? "Sized for this phone" : pane.sizedBy ? `Sized by ${pane.sizedBy}` : null;

  return (
    <div className="term-screen" style={{ background: colors.background }}>
      <header className="bar term-bar">
        <IconButton icon="chevron.left" size="lg" label="Back to Now" onClick={onBack} />
        <div className="term-head">
          <div className="term-name">
            <StatusDot state={item.light} size="sm" /> <span>{item.title}</span>
          </div>
          <div className="term-state">
            <span>
              {item.workspace ? `${item.workspace} · ` : ""}
              {stateText(item)}
              {item.detail ? ` · ${item.detail}` : ""}
            </span>
            {sizedBy && <span className="term-sized">&nbsp;· {sizedBy}</span>}
          </div>
        </div>
        <IconButton icon="ellipsis" size="lg" label="More" onClick={() => setMenu(true)} />
      </header>
      <div className="term">
        <div className="term-view" ref={view}>
          <div className="term-pan" ref={host} />
        </div>
        <Presence when={vs.selection}>
          {(_, open) => (
            <div className="term-float" data-motion="pop" data-closing={!open || undefined}>
              <Button size="lg" variant="primary" icon="doc.on.doc" onClick={() => void copy()}>
                Copy
              </Button>
              <Button size="lg" onClick={() => term.current?.viewport.clearSelection()}>
                Cancel
              </Button>
            </div>
          )}
        </Presence>
        <JumpButton className="term-jump" open={!vs.atBottom} unread={vs.unread} onClick={() => term.current?.viewport.toBottom()} />
      </div>
      {control ? (
        <div className="term-input">
          <div className="keys">
            <Button size="sm" className="key" pressed={mods.ctrl} onMouseDown={keep} onClick={() => setMods({ ...modsRef.current, ctrl: !modsRef.current.ctrl })}>
              ctrl
            </Button>
            <Button size="sm" className="key" pressed={mods.alt} onMouseDown={keep} onClick={() => setMods({ ...modsRef.current, alt: !modsRef.current.alt })} aria-label="alt">
              alt
            </Button>
            {KEYS.map((k) => (
              <Key key={k.label} label={k.label} name={k.name} repeat={k.repeat} onKey={() => write(k.data)} />
            ))}
            <Button size="sm" className="key" icon="doc.on.clipboard" aria-label="Paste" onMouseDown={keep} onClick={() => void paste()} />
          </div>
          <form className="compose" onSubmit={(e) => (e.preventDefault(), void submit())}>
            <IconButton icon="keyboard" size="lg" label="Type into the terminal" onClick={() => term.current?.t.focus()} />
            <TextField
              fill
              size="lg"
              value={text}
              onChange={setText}
              placeholder={mods.ctrl ? "ctrl + a key…" : mods.alt ? "alt + a key…" : "Message or command"}
              aria-label="Message or command"
              enterKeyHint={enter ? "send" : "done"}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <IconButton icon="return" size="lg" pressed={enter} label="Press Return after sending" onMouseDown={keep} onClick={() => setEnter(!enter)} />
            <Button type="submit" size="lg" variant="primary" icon="arrow.up" disabled={(!text && !enter) || sending} aria-label={enter ? "Send" : "Send without Return"} />
          </form>
        </div>
      ) : (
        <div className="viewonly">
          <Icon name="lock" size={14} /> View only. Your Mac can allow control in Settings → Remote Access.
        </div>
      )}
      <Dialog open={menu} onClose={() => setMenu(false)} title={item.title} padded={false}>
        <TerminalMenu
          conn={conn}
          pane={pane}
          control={control}
          fitting={fitting}
          textSize={textSize}
          onTextSize={setTextSize}
          onFit={(v) => (setFitting(v), setMenu(false))}
          onClosed={() => (setMenu(false), onBack())}
        />
      </Dialog>
      <ConfirmDialog open={link !== null} title="Open this link?" confirm="Open" onCancel={() => setLink(null)} onConfirm={() => (link && window.open(link, "_blank", "noopener,noreferrer"), setLink(null))}>
        <span className="term-link">{link}</span>
      </ConfirmDialog>
    </div>
  );
}

/** A key row button keeps the focus where it is (the keyboard stays up). Not on pointerdown: WebKit then drops the click. */
const keep = (e: { preventDefault: () => void }) => e.preventDefault();

/** A key in the row. `repeat`: held, it types again until let go. */
function Key({ label, name, repeat, onKey }: { label: string; name?: string; repeat?: boolean; onKey: () => void }) {
  const r = useRef<Repeater | null>(null);
  const on = useRef(onKey);
  on.current = onKey;
  r.current ??= new Repeater(() => on.current());
  useEffect(() => () => r.current?.release(), []);
  const stop = () => r.current?.release();
  return (
    <Button
      size="sm"
      className="key"
      aria-label={name}
      onMouseDown={keep}
      onPointerDown={() => repeat && r.current!.press("")}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      // Repeating keys type on the press; Enter or Space on the button still type once.
      onClick={(e) => (!repeat || e.detail === 0) && onKey()}
    >
      {label}
    </Button>
  );
}

function TerminalMenu(p: {
  conn: Connection;
  pane: Pane;
  control: boolean;
  fitting: boolean;
  textSize: number;
  onTextSize: (n: number) => void;
  onFit: (v: boolean) => void;
  onClosed: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const size: ReactNode = (
    <ListRow>
      <ListRowIcon icon="textformat" />
      <ListRowContent title="Text Size" detail={`${p.textSize} px on this phone`} />
      <ListRowEnd>
        <ButtonGroup joined>
          <IconButton variant="default" size="lg" icon="minus" label="Smaller" disabled={p.textSize <= MIN_FONT} onClick={() => p.onTextSize(p.textSize - 1)} />
          <IconButton variant="default" size="lg" icon="plus" label="Larger" disabled={p.textSize >= MAX_FONT} onClick={() => p.onTextSize(p.textSize + 1)} />
        </ButtonGroup>
      </ListRowEnd>
    </ListRow>
  );
  if (!p.control)
    return (
      <div className="menu-rows">
        {size}
        <p className="note padded">View only: this phone shows the Mac's terminal at the Mac's size.</p>
      </div>
    );
  const other = !p.fitting && p.pane.sizedBy;
  return (
    <div className="menu-rows">
      <ListRow role="button" onClick={() => p.onFit(!p.fitting)}>
        <ListRowIcon icon={p.fitting ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right"} tone={p.fitting ? "accent" : undefined} />
        <ListRowContent
          title={p.fitting ? "Use the Mac's Size" : "Fit to This Phone"}
          detail={
            p.fitting
              ? `${p.pane.cols}×${p.pane.rows} on the Mac until you leave`
              : other
                ? `Sized by ${p.pane.sizedBy}; this takes it over`
                : "Resizes it on the Mac while it's open here"
          }
        />
      </ListRow>
      {size}
      <ListRow
        role="button"
        onClick={() => {
          if (!confirm) return setConfirm(true);
          void p.conn.client?.call("pane.kill", { paneId: p.pane.id }).catch(() => {});
          p.onClosed();
        }}
      >
        <ListRowIcon icon="xmark" tone="danger" />
        <ListRowContent title={confirm ? "Tap Again to Close" : "Close Terminal"} detail="Ends what runs in it, on the Mac too" tone="danger" />
      </ListRow>
    </div>
  );
}
