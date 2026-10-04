// A terminal on the phone (prototype): the pane at its real size (the Mac's
// cols × rows, never resized from here), its font scaled to fit the width, and
// scrolling sideways below a readable minimum. Control-scope devices get a key
// row (Esc, Tab, ⇧Tab, arrows, ^C) and a compose bar that sends a line, which
// avoids xterm's weak spots with iOS autocorrect and dictation.

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { Pane } from "@cmd/protocol";
import type { Connection } from "./connection.ts";

const MIN_FONT = 7;
/** A cell is about this wide per point of font size (monospace). */
const CELL = 0.6;

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
  const term = useRef<Terminal | null>(null);
  const [text, setText] = useState("");
  const write = (data: string) => void conn.client?.call("pane.write", { paneId: pane.id, data }).catch(() => {});

  useEffect(() => {
    const t = new Terminal({
      cols: pane.cols,
      rows: pane.rows,
      fontSize: fontFor(host.current!.clientWidth, pane.cols),
      fontFamily: '"SF Mono", Menlo, monospace',
      disableStdin: !control,
      scrollback: 5000,
      theme: { background: "#151515" },
    });
    term.current = t;
    t.open(host.current!);
    if (control) t.onData(write);
    // Snapshot, then live output for this pane only (window.follow).
    let live = true;
    const pending: string[] = [];
    let ready = false;
    const snapshot = async () => {
      ready = false;
      const snap = await conn.client?.call("pane.snapshot", { paneId: pane.id });
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
    void conn.client?.call("window.follow", { ids: [pane.id] }).then(snapshot, () => {});
    return () => {
      live = false;
      off();
      void conn.client?.call("window.follow", { ids: [] }).catch(() => {});
      t.dispose();
    };
  }, [conn, pane.id, conn.client]);

  // The Mac resized the pane, or the phone rotated: same grid, new font size.
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    const fit = () => {
      if (t.cols !== pane.cols || t.rows !== pane.rows) t.resize(pane.cols, pane.rows);
      t.options.fontSize = fontFor(host.current!.clientWidth, pane.cols);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [pane.cols, pane.rows]);

  const send = () => {
    if (!text) return;
    write(text + "\r");
    setText("");
  };

  return (
    <div className="term-screen">
      <div className="term-title">{pane.title}</div>
      <div className="term-scroll">
        <div className="term" ref={host} />
      </div>
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

function fontFor(width: number, cols: number): number {
  return Math.max(MIN_FONT, Math.floor((width / (cols * CELL)) * 10) / 10);
}
