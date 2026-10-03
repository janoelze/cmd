// Text window: a CodeMirror 6 editor for one file — syntax highlighting (language
// loaded on demand from the file name), find/replace (⌘F), multiple cursors,
// bracket matching, folding. ⌘S saves (refusing if the file changed on disk);
// an unedited buffer reloads when the window is focused again.

import { useCallback, useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, type Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import type { AppWindow } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { registerWindowActions } from "../windowActions.ts";
import { formatBytes } from "../model.ts";
import { useStore } from "../store.ts";
import { Symbol } from "./Symbol.tsx";

/** Blend CodeMirror's One Dark into the app: same background, fonts from settings. */
const appTheme = (fontFamily: string, fontSize: number) =>
  EditorView.theme(
    {
      "&": { height: "100%", backgroundColor: "var(--well)", fontSize: `${fontSize}px` },
      ".cm-scroller": { fontFamily, lineHeight: "1.5" },
      ".cm-gutters": { backgroundColor: "var(--well)", borderRight: "1px solid var(--separator)" },
      ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "rgb(255 255 255 / 0.04)" },
      "&.cm-focused": { outline: "none" },
      ".cm-panels": { backgroundColor: "var(--bg)" },
    },
    { dark: true },
  );

export function TextView({ win, focused }: { win: AppWindow; focused: boolean }) {
  const file = win.path ?? "";
  const settings = useStore().settings.settings;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const saved = useRef<Text | null>(null);
  const comps = useRef({ lang: new Compartment(), readOnly: new Compartment(), theme: new Compartment() });
  const [meta, setMeta] = useState({ size: 0, mtime: 0, truncated: false, binary: false });
  const [dirty, setDirty] = useState(false);
  const [lines, setLines] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const metaRef = useRef(meta);
  metaRef.current = meta;

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
          oneDark,
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
    // Syntax highlighting for the file type, loaded on demand.
    const desc = LanguageDescription.matchFilename(languages, file.split("/").pop() ?? "");
    if (desc) void desc.load().then((lang) => v.dispatch({ effects: c.lang.reconfigure(lang) }));
    return () => {
      v.destroy();
      view.current = null;
    };
  }, [file]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow font settings.
  useEffect(() => {
    view.current?.dispatch({
      effects: comps.current.theme.reconfigure(appTheme(settings["terminal.fontFamily"], settings["terminal.fontSize"])),
    });
  }, [settings]);

  /** Load (or reload) the file into the editor. */
  const load = useCallback(() => {
    cmd.call("fs.read", { path: file }).then(
      (r) => {
        const v = view.current;
        if (!v) return;
        setMeta(r);
        setError(null);
        if (v.state.doc.toString() !== r.text) {
          v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: r.text } });
        }
        saved.current = v.state.doc;
        setDirty(false);
        setLines(v.state.doc.lines);
        v.dispatch({ effects: comps.current.readOnly.reconfigure(EditorState.readOnly.of(r.truncated || r.binary)) });
      },
      (e: Error) => setError(e.message),
    );
  }, [file]);
  useEffect(load, [load]);

  // Coming back to the window: pick up outside changes unless there are unsaved
  // edits, and take keyboard focus (unless a text field elsewhere has it).
  useEffect(() => {
    if (!focused) return;
    if (!dirty) load();
    const active = document.activeElement;
    const typing =
      (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) && !active.closest(".xterm");
    if (!typing) view.current?.focus();
  }, [focused]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    const v = view.current;
    const m = metaRef.current;
    if (!v || m.truncated || m.binary) return;
    try {
      const doc = v.state.doc;
      const r = await cmd.call("fs.write", { path: file, text: doc.toString(), expectMtime: m.mtime });
      saved.current = doc;
      setDirty(!v.state.doc.eq(doc));
      setMeta((x) => ({ ...x, size: r.size, mtime: r.mtime }));
      setStatus("Saved");
      setTimeout(() => setStatus(null), 1500);
    } catch (e) {
      setStatus((e as Error).message);
    }
  }, [file]);

  useEffect(() => registerWindowActions(win.id, { save }), [win.id, save]);

  const readOnly = meta.truncated || meta.binary;
  return (
    <div className="textwin">
      <div className="window-toolbar">
        <Symbol name="doc.text" size={13} className="file-icon" />
        <span className="textwin-path" title={file}>
          {file.replace(/^\/Users\/[^/]+/, "~")}
        </span>
        <span className="textwin-meta">
          {status ??
            (dirty
              ? "Edited"
              : readOnly
                ? meta.truncated
                  ? "Read-only (truncated)"
                  : "Read-only (binary)"
                : `${lines} lines · ${formatBytes(meta.size)}`)}
        </span>
        <button className="icon-btn" disabled={!dirty || readOnly} onClick={() => void save()} title="Save (⌘S)">
          <Symbol name="square.and.arrow.down" size={13} />
        </button>
        <button className="icon-btn" onClick={() => cmd.openPath(file)} title="Open with default app">
          <Symbol name="arrow.up.forward.app" size={13} />
        </button>
      </div>
      {error && <div className="file-error">{error}</div>}
      <div className="textwin-editor" ref={host} />
    </div>
  );
}
