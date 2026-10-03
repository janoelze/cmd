// Text window: a small monospace editor for one file. ⌘S saves (refusing if the
// file changed on disk meanwhile); unchanged buffers reload when the window is
// focused again, so edits made elsewhere show up.

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppWindow } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { registerWindowActions } from "../windowActions.ts";
import { formatBytes } from "../model.ts";
import { Symbol } from "./Symbol.tsx";

export function TextView({ win, focused }: { win: AppWindow; focused: boolean }) {
  const file = win.path ?? "";
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [meta, setMeta] = useState({ size: 0, mtime: 0, truncated: false, binary: false });
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const dirty = text !== null && text !== saved;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const load = useCallback(() => {
    cmd.call("fs.read", { path: file }).then(
      (r) => {
        setText(r.text);
        setSaved(r.text);
        setMeta(r);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [file]);
  useEffect(load, [load]);

  // Coming back to the window: pick up outside changes unless there are unsaved edits.
  useEffect(() => {
    if (!focused) return;
    if (!dirtyRef.current) load();
    const active = document.activeElement;
    const typing = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && !active.closest(".xterm") && active !== area.current;
    if (!typing) area.current?.focus();
  }, [focused]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    if (text === null || meta.truncated || meta.binary) return;
    try {
      const r = await cmd.call("fs.write", { path: file, text, expectMtime: meta.mtime });
      setSaved(text);
      setMeta((m) => ({ ...m, size: r.size, mtime: r.mtime }));
      setStatus("Saved");
      setTimeout(() => setStatus(null), 1500);
    } catch (e) {
      setStatus((e as Error).message);
    }
  }, [file, text, meta]);

  useEffect(() => registerWindowActions(win.id, { save }), [win.id, save]);

  const readOnly = meta.truncated || meta.binary;
  const lines = text === null ? 0 : text.split("\n").length;

  return (
    <div className="textwin">
      <div className="window-toolbar">
        <Symbol name="doc.text" size={13} className="file-icon" />
        <span className="textwin-path" title={file}>
          {file.replace(/^\/Users\/[^/]+/, "~")}
        </span>
        <span className="textwin-meta">
          {status ?? (dirty ? "Edited" : readOnly ? (meta.truncated ? "Read-only (truncated)" : "Read-only (binary)") : `${lines} lines · ${formatBytes(meta.size)}`)}
        </span>
        <button className="icon-btn" disabled={!dirty || readOnly} onClick={() => void save()} title="Save (⌘S)">
          <Symbol name="square.and.arrow.down" size={13} />
        </button>
        <button className="icon-btn" onClick={() => cmd.openPath(file)} title="Open with default app">
          <Symbol name="arrow.up.forward.app" size={13} />
        </button>
      </div>
      {error ? (
        <div className="file-error">{error}</div>
      ) : (
        <textarea
          ref={area}
          className="textwin-area"
          value={text ?? ""}
          readOnly={readOnly}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Tab inserts two spaces instead of moving focus.
            if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: s, selectionEnd: t } = el;
              const next = el.value.slice(0, s) + "  " + el.value.slice(t);
              setText(next);
              requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
            }
          }}
        />
      )}
    </div>
  );
}
