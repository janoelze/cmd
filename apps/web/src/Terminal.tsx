// A terminal on the phone (prototype; docs/13, "Terminals on a phone"). The
// page never scrolls: the terminal fills what's left above the keyboard and
// only its scrollback scrolls. With control access it sizes the Mac's terminal
// to that space (pane.fitOverride) while it's shown, and refits as the
// keyboard opens and closes or the phone rotates; leaving, locking the phone or
// disconnecting gives the Mac its size back. If the Mac takes it back (someone
// types there), the phone shows the Mac's size scaled down until you tap Fit.
// View-only devices always show the Mac's size, scaled to fit.

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Pane } from "@cmd/protocol";
import type { Connection } from "./connection.ts";

const FONT = 13;
const MIN_FONT = 5;
/** A cell's size per point of font size (monospace, xterm's default line height). */
const CELL_W = 0.6;
const CELL_H = 1.2;
/** The range the core accepts (remote/policy.ts). */
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const KEYS: { label: string; data: string }[] = [
  { label: "esc", data: "\x1b" },
  { label: "tab", data: "\t" },
  { label: "⇧tab", data: "\x1b[Z" },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "←", data: "\x1b[D" },
  { label: "→", data: "\x1b[C" },
  { label: "^C", data: "\x03" },
  { label: "⏎", data: "\r" },
];

export function TerminalScreen({ conn, pane, control }: { conn: Connection; pane: Pane; control: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<{ t: Terminal; fit: FitAddon } | null>(null);
  const [text, setText] = useState("");
  /** This phone sizes the terminal (else: the Mac's size, scaled). */
  const [fitting, setFitting] = useState(control);
  const holding = useRef(false);
  /** The core confirmed our size (sizedBy set) since we asked: a null after that means the Mac took it back. */
  const confirmed = useRef(false);
  const client = conn.client;
  const write = (data: string) => void client?.call("pane.write", { paneId: pane.id, data }).catch(() => {});

  // The terminal: snapshot, then live output for this pane only (window.follow).
  useEffect(() => {
    const t = new Terminal({
      cols: pane.cols,
      rows: pane.rows,
      fontSize: FONT,
      fontFamily: '"SF Mono", Menlo, monospace',
      disableStdin: !control,
      scrollback: 5000,
      theme: { background: "#151515" },
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(host.current!);
    term.current = { t, fit };
    if (control) t.onData(write);
    let live = true;
    let ready = false;
    const pending: string[] = [];
    const snapshot = async () => {
      ready = false;
      const snap = await client?.call("pane.snapshot", { paneId: pane.id });
      if (!live || !snap) return;
      t.reset();
      t.resize(snap.cols, snap.rows);
      t.write(snap.data);
      ready = true;
      for (const d of pending.splice(0)) t.write(d);
    };
    const off = conn.onEvent((e) => {
      if (e.type === "pane.output" && e.paneId === pane.id) (ready ? t.write(e.data) : pending.push(e.data));
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
        if (x.t.cols !== cols || x.t.rows !== rows) x.t.resize(cols, rows);
        if (!holding.current || pane.cols !== cols || pane.rows !== rows) {
          holding.current = true;
          void client?.call("pane.fitOverride", { paneId: pane.id, cols, rows }).catch(() => {});
        }
      } else {
        if (x.t.cols !== pane.cols || x.t.rows !== pane.rows) x.t.resize(pane.cols, pane.rows);
        x.t.options.fontSize = Math.max(MIN_FONT, Math.min(FONT, el.clientWidth / (pane.cols * CELL_W), el.clientHeight / (pane.rows * CELL_H)));
      }
    };
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

  const send = () => {
    if (!text) return;
    write(text + "\r");
    setText("");
  };

  return (
    <div className="term-screen">
      <div className="term-title">
        <span>{pane.title}</span>
        {control && !fitting && (
          <button className="fit" onClick={() => setFitting(true)}>
            Sized for your Mac · Fit
          </button>
        )}
      </div>
      <div className="term" ref={host} />
      {control ? (
        <div className="term-input">
          <div className="keys">
            {KEYS.map((k) => (
              <button key={k.label} onClick={() => write(k.data)}>
                {k.label}
              </button>
            ))}
          </div>
          <form className="compose" onSubmit={(e) => (e.preventDefault(), send())}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a line, send with ⏎" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <button type="submit" disabled={!text}>
              Send
            </button>
          </form>
        </div>
      ) : (
        <div className="viewonly">View only. Your Mac can allow control in Settings → Remote Access.</div>
      )}
    </div>
  );
}
