// A terminal on the phone (prototype; docs/13, "Terminals on a phone"). The
// page never scrolls: the terminal fills what's left above the keyboard and
// only its scrollback scrolls. With control access it sizes the Mac's terminal
// to that space (pane.fitOverride) while it's shown, and refits as the
// keyboard opens and closes or the phone rotates; leaving, locking the phone or
// disconnecting gives the Mac its size back. If the Mac takes it back (someone
// types there), the phone shows the Mac's size scaled down until you tap Fit.
// View-only devices always show the Mac's size, scaled to fit. Above it: the
// state line (what the agent is doing or asking), below it a key row (with a
// sticky ctrl) and a compose bar; the menu switches sizing and closes it.

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Pane } from "@cmd/protocol";
import type { Connection } from "./connection.ts";
import { stateText, type Item } from "./model.ts";
import { Screen } from "./screen.ts";
import { Icon, Led, Sheet } from "./ui.tsx";

const FONT = 13;
const MIN_FONT = 5;
/** A cell's size per point of font size (monospace, xterm's default line height). */
const CELL_W = 0.6;
const CELL_H = 1.2;
/** cmd's Dark theme (apps/desktop themes/dark.ts). */
const THEME = {
  background: "#161618", foreground: "#e6e6ea", cursor: "#9d9dff", selectionBackground: "#3a3a6e",
  black: "#16161c", red: "#ff6b5e", green: "#7bd88f", yellow: "#ffd866", blue: "#8f8fff", magenta: "#e08cff", cyan: "#6fe0e8", white: "#d6d6dc",
  brightBlack: "#6c6c78", brightRed: "#ff8a7f", brightGreen: "#9be6aa", brightYellow: "#ffe38f", brightBlue: "#b0b0ff", brightMagenta: "#eeb0ff", brightCyan: "#9aeef3", brightWhite: "#ffffff",
};
/** The range the core accepts (remote/policy.ts). */
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const KEYS: { label: string; data: string; wide?: boolean }[] = [
  { label: "esc", data: "\x1b" },
  { label: "tab", data: "\t" },
  { label: "⇧tab", data: "\x1b[Z", wide: true },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "←", data: "\x1b[D" },
  { label: "→", data: "\x1b[C" },
  { label: "^C", data: "\x03" },
  { label: "|", data: "|" },
  { label: "~", data: "~" },
  { label: "/", data: "/" },
  { label: "-", data: "-" },
  { label: "⏎", data: "\r" },
];

/** ctrl + a key: its control character (ctrl-c → \x03), else the key as is. */
function withCtrl(data: string): string {
  const c = data[0];
  if (!c || data.length !== 1) return data;
  const code = c.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  if (c === " ") return "\x00";
  return data;
}

export function TerminalScreen({ conn, item, control, onBack }: { conn: Connection; item: Item; control: boolean; onBack: () => void }) {
  const pane: Pane = item.pane;
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<{ t: Terminal; fit: FitAddon; screen: Screen } | null>(null);
  /** Sizes the terminal (the size effect's), again once a snapshot is parsed. */
  const sizeRef = useRef<() => void>(() => {});
  const [text, setText] = useState("");
  /** This phone sizes the terminal (else: the Mac's size, scaled). */
  const [fitting, setFitting] = useState(control);
  const holding = useRef(false);
  /** The core confirmed our size (sizedBy set) since we asked: a null after that means the Mac took it back. */
  const confirmed = useRef(false);
  const [ctrl, setCtrl] = useState(false);
  const ctrlRef = useRef(false);
  ctrlRef.current = ctrl;
  const [menu, setMenu] = useState(false);
  const client = conn.client;
  const send = (data: string) => void client?.call("pane.write", { paneId: pane.id, data }).catch(() => {});
  /** Keys typed or tapped; a sticky ctrl applies to the next one. */
  const write = (data: string) => {
    if (ctrlRef.current) {
      setCtrl(false);
      return send(withCtrl(data));
    }
    send(data);
  };

  // The terminal: snapshot, then live output for this pane only (window.follow).
  useEffect(() => {
    const t = new Terminal({
      cols: pane.cols,
      rows: pane.rows,
      fontSize: FONT,
      fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
      disableStdin: !control,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(host.current!);
    // Written at the snapshot's size; no resizing until it is parsed, then the size again.
    const screen = new Screen(t);
    screen.onParsed = () => sizeRef.current();
    term.current = { t, fit, screen };
    if (control) t.onData((d) => write(d));
    let live = true;
    const snapshot = async () => {
      screen.awaitSnapshot();
      const snap = await client?.call("pane.snapshot", { paneId: pane.id });
      if (!live || !snap) return;
      screen.snapshot(snap);
    };
    const off = conn.onEvent((e) => {
      if (e.type === "pane.output" && e.paneId === pane.id) screen.output(e.data);
      else if (e.type === "pane.resync" && e.paneId === pane.id) void snapshot();
    });
    void client?.call("window.follow", { ids: [pane.id] }).then(snapshot, () => {});
    return () => {
      live = false;
      off();
      void client?.call("window.follow", { ids: [] }).catch(() => {});
      if (holding.current) void client?.call("pane.fitOverride", { paneId: pane.id, release: true }).catch(() => {});
      holding.current = false;
      confirmed.current = false;
      term.current = null;
      t.dispose();
    };
  }, [conn, pane.id, client]);

  // Size: fit the space (and the Mac's terminal to it), or scale the Mac's size into it.
  useEffect(() => {
    const el = host.current!;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = () => {
      const x = term.current;
      if (!x || !el.clientWidth || !el.clientHeight) return;
      if (fitting && document.visibilityState === "visible") {
        x.t.options.fontSize = FONT;
        const d = x.fit.proposeDimensions();
        if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return;
        const cols = clamp(d.cols, 20, 300);
        const rows = clamp(d.rows, 5, 200);
        x.screen.resize({ cols, rows }, () => {
          if (holding.current && pane.cols === cols && pane.rows === rows) return;
          holding.current = true;
          void client?.call("pane.fitOverride", { paneId: pane.id, cols, rows }).catch(() => {});
        });
      } else {
        x.screen.resize({ cols: pane.cols, rows: pane.rows });
        x.t.options.fontSize = Math.max(MIN_FONT, Math.min(FONT, el.clientWidth / (pane.cols * CELL_W), el.clientHeight / (pane.rows * CELL_H)));
      }
    };
    sizeRef.current = apply;
    // The keyboard and rotation change the space in steps; settle before resizing the PTY.
    const later = () => (clearTimeout(timer), (timer = setTimeout(apply, 120)));
    const ro = new ResizeObserver(later);
    ro.observe(el);
    // Locked or switched away: give the Mac its size back; refit on return.
    const vis = () => {
      if (document.visibilityState === "hidden" && holding.current) {
        holding.current = false;
        confirmed.current = false;
        void client?.call("pane.fitOverride", { paneId: pane.id, release: true }).catch(() => {});
      } else later();
    };
    document.addEventListener("visibilitychange", vis);
    apply();
    return () => (clearTimeout(timer), ro.disconnect(), document.removeEventListener("visibilitychange", vis));
  }, [fitting, pane.cols, pane.rows, pane.id, client]);

  // The Mac took it back (someone typed there): stop fitting until asked again.
  useEffect(() => {
    if (!holding.current) return;
    if (pane.sizedBy !== null) confirmed.current = true;
    else if (confirmed.current) {
      holding.current = false;
      confirmed.current = false;
      setFitting(false);
    }
  }, [pane.sizedBy]);

  const submit = () => {
    if (!text) return;
    write(text + "\r");
    setText("");
  };
  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t) send(`\x1b[200~${t}\x1b[201~`);
    } catch {}
  };

  return (
    <div className="term-screen">
      <header className="bar term-bar">
        <button className="icon-btn" onClick={onBack} aria-label="Back to Now">
          <Icon name="back" size={22} />
        </button>
        <div className="term-head">
          <div className="term-name">
            <Led light={item.light} /> <span>{item.title}</span>
          </div>
          <div className="term-state">
            {item.workspace ? `${item.workspace} · ` : ""}
            {stateText(item)}
            {item.detail ? ` · ${item.detail}` : ""}
          </div>
        </div>
        <button className="icon-btn" onClick={() => setMenu(true)} aria-label="More">
          <Icon name="more" size={22} />
        </button>
      </header>
      <div className="term" ref={host} />
      {control ? (
        <div className="term-input">
          <div className="keys">
            <button className={`key${ctrl ? " on" : ""}`} onClick={() => setCtrl(!ctrl)}>
              ctrl
            </button>
            {KEYS.map((k) => (
              <button key={k.label} className={`key${k.wide ? " wide" : ""}`} onClick={() => write(k.data)}>
                {k.label}
              </button>
            ))}
            <button className="key" onClick={() => void paste()} aria-label="Paste">
              <Icon name="paste" size={16} />
            </button>
          </div>
          <form className="compose" onSubmit={(e) => (e.preventDefault(), submit())}>
            <button type="button" className="icon-btn" aria-label="Type into the terminal" onClick={() => term.current?.t.focus()}>
              <Icon name="keyboard" size={20} />
            </button>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={ctrl ? "ctrl + a key…" : "Message or command"}
              enterKeyHint="send"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button type="submit" className="send" disabled={!text} aria-label="Send">
              ⏎
            </button>
          </form>
        </div>
      ) : (
        <div className="viewonly">
          <Icon name="lock" size={14} /> View only. Your Mac can allow control in Settings → Remote Access.
        </div>
      )}
      {menu && (
        <Sheet title={item.title} onClose={() => setMenu(false)}>
          <TerminalMenu conn={conn} pane={pane} control={control} fitting={fitting} onFit={(v) => (setFitting(v), setMenu(false))} onClosed={() => (setMenu(false), onBack())} />
        </Sheet>
      )}
    </div>
  );
}

function TerminalMenu(p: { conn: Connection; pane: Pane; control: boolean; fitting: boolean; onFit: (v: boolean) => void; onClosed: () => void }) {
  const [confirm, setConfirm] = useState(false);
  if (!p.control) return <div className="sheet-note">View only: this phone shows the Mac's terminal at the Mac's size.</div>;
  return (
    <div className="sheet-list">
      <button className="sheet-item" onClick={() => p.onFit(!p.fitting)}>
        <Icon name="fit" />
        <span>
          {p.fitting ? "Use the Mac's size" : "Fit to this phone"}
          <small>{p.fitting ? `Now ${p.pane.cols}×${p.pane.rows}, sized for this phone` : "The Mac's terminal takes this screen's size while you look at it"}</small>
        </span>
      </button>
      <button
        className="sheet-item danger"
        onClick={() => {
          if (!confirm) return setConfirm(true);
          void p.conn.client?.call("pane.kill", { paneId: p.pane.id }).catch(() => {});
          p.onClosed();
        }}
      >
        <Icon name="close" />
        <span>
          {confirm ? "Tap again to close it" : "Close terminal"}
          <small>Ends what runs in it, on the Mac too</small>
        </span>
      </button>
    </div>
  );
}
