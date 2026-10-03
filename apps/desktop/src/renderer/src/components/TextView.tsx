// Text window: a CodeMirror 6 editor for one file. No toolbar — the title bar
// (or, in focus mode, the status bar) shows the file, folder and state; ⌘S saves.
//
//  - Styled from the app's tokens (background, separators, selection, terminal
//    font) with syntax colours from the terminal palette (--syn-* in styles.css).
//  - Live: the file is watched; outside changes merge in as a minimal edit
//    (cursor and scroll survive) when there are no unsaved edits, otherwise a
//    banner asks whether to reload or keep yours. Saving never silently
//    overwrites a file that changed on disk.

import { useCallback, useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, type Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { AppWindow } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { formatBytes } from "../model.ts";
import { onFsChanged, useStore } from "../store.ts";
import { registerWindowActions, setWindowStatus } from "../windowActions.ts";
import { syntax } from "../editor/syntax.ts";

/** Editor chrome from the app's design tokens. */
const appTheme = (fontFamily: string, fontSize: number) =>
  EditorView.theme(
    {
      "&": { height: "100%", color: "var(--text)", backgroundColor: "var(--well)", fontSize: `${fontSize}px` },
      ".cm-scroller": { fontFamily, lineHeight: "1.5" },
      ".cm-content": { caretColor: "var(--syn-cursor)", padding: "8px 0" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--syn-cursor)", borderLeftWidth: "2px" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: "var(--syn-selection) !important",
      },
      ".cm-gutters": {
        backgroundColor: "var(--well)",
        color: "var(--text-dim)",
        border: "none",
        borderRight: "1px solid var(--separator)",
      },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px", opacity: "0.6" },
      ".cm-activeLine": { backgroundColor: "var(--bg-hover)" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
      ".cm-foldPlaceholder": { backgroundColor: "var(--bg-selected)", border: "none", color: "var(--text-dim)" },
      ".cm-matchingBracket": { backgroundColor: "var(--bg-selected)", outline: "1px solid var(--separator)" },
      ".cm-searchMatch": { backgroundColor: "rgb(255 214 10 / 0.18)" },
      ".cm-searchMatch-selected": { backgroundColor: "rgb(255 214 10 / 0.35)" },
      ".cm-panels": { backgroundColor: "var(--bg)", color: "var(--text)" },
      ".cm-panels-bottom": { borderTop: "1px solid var(--separator)" },
      ".cm-panel input, .cm-panel button": { font: "12px var(--font-ui)" },
      ".cm-tooltip": { backgroundColor: "var(--bg-elevated)", border: "1px solid var(--separator)" },
      "&.cm-focused": { outline: "none" },
    },
    { dark: true },
  );

/** The smallest single change turning `a` into `b` (keeps cursor and scroll stable). */
function minimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) endA--, endB--;
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

export function TextView({ win, focused }: { win: AppWindow; focused: boolean }) {
  const file = typeof win.state.path === "string" ? win.state.path : "";
  const settings = useStore().settings.settings;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const saved = useRef<Text | null>(null);
  const comps = useRef({ lang: new Compartment(), readOnly: new Compartment(), theme: new Compartment() });
  const meta = useRef({ size: 0, mtime: 0, truncated: false, binary: false });
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const [lines, setLines] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The file changed on disk while there were unsaved edits. */
  const [conflict, setConflict] = useState(false);

  // Create the editor once per window.
  useEffect(() => {
    const c = comps.current;
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: "",
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          syntaxHighlighting(syntax),
          c.theme.of(appTheme(settings["terminal.fontFamily"], settings["terminal.fontSize"])),
          c.lang.of([]),
          c.readOnly.of(EditorState.readOnly.of(false)),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            setDirty(!!saved.current && !u.state.doc.eq(saved.current));
            setLines(u.state.doc.lines);
          }),
        ],
      }),
    });
    view.current = v;
    const desc = LanguageDescription.matchFilename(languages, file.split("/").pop() ?? "");
    if (desc) void desc.load().then((lang) => v.dispatch({ effects: c.lang.reconfigure(lang) }));
    return () => {
      v.destroy();
      view.current = null;
    };
  }, [file]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    view.current?.dispatch({
      effects: comps.current.theme.reconfigure(appTheme(settings["terminal.fontFamily"], settings["terminal.fontSize"])),
    });
  }, [settings]);

  /** Load the file; merges into the buffer as a minimal change. */
  const load = useCallback(async () => {
    try {
      const r = await cmd.call("fs.read", { path: file });
      const v = view.current;
      if (!v) return;
      meta.current = r;
      setError(null);
      const change = minimalChange(v.state.doc.toString(), r.text);
      if (change) v.dispatch({ changes: change });
      saved.current = v.state.doc;
      setDirty(false);
      setConflict(false);
      setLines(v.state.doc.lines);
      v.dispatch({ effects: comps.current.readOnly.reconfigure(EditorState.readOnly.of(r.truncated || r.binary)) });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [file]);
  useEffect(() => void load(), [load]);

  // Live: watch the file; reload when clean, ask when there are unsaved edits.
  useEffect(() => {
    void cmd.call("fs.watch", { path: file }).catch(() => {});
    const off = onFsChanged((p) => {
      if (p !== file) return;
      void cmd.call("fs.read", { path: file }).then((r) => {
        if (Math.abs(r.mtime - meta.current.mtime) < 1) return; // our own save
        if (dirtyRef.current) setConflict(true);
        else void load();
      });
    });
    return () => {
      off();
      void cmd.call("fs.unwatch", { path: file }).catch(() => {});
    };
  }, [file, load]);

  useEffect(() => {
    if (!focused) return;
    const active = document.activeElement;
    const typing = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && !active.closest(".xterm");
    if (!typing) view.current?.focus();
  }, [focused]);

  const save = useCallback(async () => {
    const v = view.current;
    const m = meta.current;
    if (!v || m.truncated || m.binary) return;
    try {
      const doc = v.state.doc;
      const r = await cmd.call("fs.write", { path: file, text: doc.toString(), expectMtime: m.mtime });
      meta.current = { ...m, size: r.size, mtime: r.mtime };
      saved.current = doc;
      setDirty(!v.state.doc.eq(doc));
      setConflict(false);
      setNotice("Saved");
      setTimeout(() => setNotice(null), 1500);
    } catch (e) {
      setNotice(null);
      setConflict(/changed on disk/i.test((e as Error).message));
      if (!/changed on disk/i.test((e as Error).message)) setError((e as Error).message);
    }
  }, [file]);

  /** Keep my edits: overwrite the disk version on the next save. */
  const keepMine = async () => {
    const r = await cmd.call("fs.read", { path: file }).catch(() => null);
    if (r) meta.current = { ...meta.current, mtime: r.mtime };
    setConflict(false);
  };

  useEffect(
    () => registerWindowActions(win.id, { save, openExternally: () => cmd.openPath(file) }),
    [win.id, save, file],
  );

  // What the title bar / status bar shows for this window.
  const m = meta.current;
  const label =
    notice ??
    (dirty ? "Edited" : m.truncated ? "Read-only (truncated)" : m.binary ? "Read-only (binary)" : `${lines} lines · ${formatBytes(m.size)}`);
  useEffect(() => setWindowStatus(win.id, { label, dirty }), [win.id, label, dirty]);
  useEffect(() => () => setWindowStatus(win.id, null), [win.id]);

  return (
    <div className="textwin">
      {conflict && (
        <div className="textwin-banner">
          <span>This file changed on disk.</span>
          <button className="btn" onClick={() => void load()}>
            Reload
          </button>
          <button className="btn" onClick={() => void keepMine()}>
            Keep mine
          </button>
        </div>
      )}
      {error && <div className="file-error">{error}</div>}
      <div className="textwin-editor" ref={host} />
    </div>
  );
}
