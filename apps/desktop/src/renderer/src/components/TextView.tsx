// Text window: a CodeMirror 6 editor for one file, or an untitled buffer
// (File › New Text Window) whose first ⌘S asks where to save. No toolbar — the title bar
// (or, in focus mode, the status bar) shows the file, folder and state; ⌘S saves.
//
//  - Styled from the app's tokens (background, separators, selection, terminal
//    font) with syntax colours from the terminal palette (--syn-* in styles.css).
//  - Live: the file is watched; outside changes merge in as a minimal edit
//    (cursor and scroll survive) when there are no unsaved edits, otherwise a
//    banner asks whether to reload or keep yours. Saving never silently
//    overwrites a file that changed on disk.
//  - Untitled: the text is kept in the window's state (`draft`), so it survives
//    reloads and core restarts until it's saved.

import { Button, Callout, EmptyState } from "@cmd/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorSelection, EditorState, Text } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { searchPanelOpen } from "@codemirror/search";
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { AppWindow } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { formatBytes } from "../model.ts";
import { onFsChanged, useStoreValue } from "../store.ts";
import { registerWindowActions, setWindowStatus } from "../windowActions.ts";
import { syntax } from "../editor/syntax.ts";
import { editorFindable, findPanel } from "../editor/find.ts";
import { shareFindQuery, useFind } from "../find.tsx";
import { useTheme } from "@cmd/ui/themes";

/** Editor chrome from the app's design tokens. */
const appTheme = (fontFamily: string, fontSize: number, dark: boolean) =>
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
      ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--match) 18%, transparent)" },
      ".cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--match) 35%, transparent)" },
      ".cm-panels": { backgroundColor: "var(--bg)", color: "var(--text)" },
      ".cm-panels-bottom": { borderTop: "1px solid var(--separator)" },
      ".cm-panel input, .cm-panel button": { font: "12px var(--font-ui)" },
      // Find/replace fields and buttons in the app's input style (styles.css --input-*).
      ".cm-textfield": {
        color: "var(--text)", backgroundColor: "var(--well)", border: "none", borderRadius: "5px",
        padding: "2px 7px", boxShadow: "inset 0 0 0 1px var(--input-edge)", outline: "none",
      },
      ".cm-textfield:focus": { boxShadow: "var(--input-ring)" },
      ".cm-button": {
        color: "var(--text)", backgroundImage: "none", backgroundColor: "var(--input-bg)", border: "none",
        borderRadius: "5px", padding: "2px 8px", boxShadow: "inset 0 0 0 1px var(--input-edge)",
      },
      ".cm-button:active": { backgroundImage: "none", backgroundColor: "var(--bg-selected)" },
      ".cm-button:focus-visible": { outline: "none", boxShadow: "var(--input-ring)" },
      ".cm-panel input[type=checkbox]": { accentColor: "var(--accent)" },
      ".cm-tooltip": { backgroundColor: "var(--bg-elevated)", border: "1px solid var(--separator)" },
      "&.cm-focused": { outline: "none" },
    },
    { dark },
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
  const dir = typeof win.state.dir === "string" ? win.state.dir : "";
  const fileRef = useRef(file);
  fileRef.current = file;
  const settings = useStoreValue((s) => s.settings.settings);
  const dark = useTheme().appearance === "dark";
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const saved = useRef<Text | null>(null);
  const comps = useRef({ lang: new Compartment(), readOnly: new Compartment(), theme: new Compartment() });
  const meta = useRef({ size: 0, mtime: 0, truncated: false, binary: false });
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const [lines, setLines] = useState(0);
  /** The file has been read once; until then there's no status worth showing. */
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The file changed on disk while there were unsaved edits. */
  const [conflict, setConflict] = useState(false);

  // Create the editor once per window (an untitled buffer keeps it when saved).
  useEffect(() => {
    const c = comps.current;
    const draft = !file && typeof win.state.draft === "string" ? win.state.draft : "";
    let persist: ReturnType<typeof setTimeout> | undefined;
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: draft,
        extensions: [
          basicSetup,
          findPanel,
          keymap.of([indentWithTab]),
          // Like a terminal's "Terminal input"; the window around it carries the file's name.
          EditorView.contentAttributes.of({ "aria-label": "Text editor" }),
          syntaxHighlighting(syntax),
          c.theme.of(appTheme(settings["font.code"], settings["font.codeSize"], dark)),
          c.lang.of([]),
          c.readOnly.of(EditorState.readOnly.of(false)),
          EditorView.updateListener.of((u) => {
            if (findOpen.current && searchPanelOpen(u.startState) && !searchPanelOpen(u.state)) closeFind.current("close");
            if (!u.docChanged) return;
            setDirty(!!saved.current && !u.state.doc.eq(saved.current));
            setLines(u.state.doc.lines);
            if (fileRef.current) return;
            clearTimeout(persist);
            persist = setTimeout(() => void cmd.call("window.update", { id: win.id, state: { draft: u.state.doc.toString() } }), 500);
          }),
        ],
      }),
    });
    view.current = v;
    if (!file) {
      // Nothing on disk: unsaved until the first ⌘S.
      saved.current = Text.empty;
      setDirty(draft !== "");
      setLines(v.state.doc.lines);
      setLoaded(true);
    }
    return () => {
      clearTimeout(persist);
      v.destroy();
      view.current = null;
    };
  }, [win.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const desc = file ? LanguageDescription.matchFilename(languages, file.split("/").pop() ?? "") : null;
    if (desc) void desc.load().then((lang) => view.current?.dispatch({ effects: comps.current.lang.reconfigure(lang) }));
    else view.current?.dispatch({ effects: comps.current.lang.reconfigure([]) });
  }, [file]);

  useEffect(() => {
    view.current?.dispatch({
      effects: comps.current.theme.reconfigure(appTheme(settings["font.code"], settings["font.codeSize"], dark)),
    });
  }, [settings, dark]);

  /** Load the file; merges into the buffer as a minimal change. */
  const load = useCallback(async () => {
    if (!file) return;
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
      setLoaded(true);
      v.dispatch({ effects: comps.current.readOnly.reconfigure(EditorState.readOnly.of(r.truncated || r.binary)) });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [file]);
  useEffect(() => void load(), [load]);

  // Live: watch the file; reload when clean, ask when there are unsaved edits.
  useEffect(() => {
    if (!file) return;
    void cmd.call("fs.watch", { path: file }).catch(() => {});
    const off = onFsChanged((p) => {
      if (p !== file) return;
      // Gone (deleted, moved away): the window keeps its text, to save again.
      void cmd.call("fs.read", { path: file }).then(
        (r) => {
          if (Math.abs(r.mtime - meta.current.mtime) < 1) return; // our own save
          if (dirtyRef.current) setConflict(true);
          else void load();
        },
        () => {},
      );
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
      // Untitled: ask where (the save panel confirms overwriting), then the window becomes that file's.
      const target = file || (await cmd.chooseSavePath(`${dir || "~"}/Untitled.txt`));
      if (!target) return;
      const doc = v.state.doc;
      const r = await cmd.call("fs.write", { path: target, text: doc.toString(), expectMtime: file ? m.mtime : undefined });
      meta.current = { ...m, size: r.size, mtime: r.mtime };
      if (!file) await cmd.call("window.update", { id: win.id, state: { path: target } });
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
  }, [file, dir, win.id]);

  /** Keep my edits: overwrite the disk version on the next save. */
  const keepMine = async () => {
    const r = await cmd.call("fs.read", { path: file }).catch(() => null);
    if (r) meta.current = { ...meta.current, mtime: r.mtime };
    setConflict(false);
  };

  // Find (⌘F ⌘G ⇧⌘G, ⌥⌘F replace) with the app's bar; replace only where the text can be edited.
  const editable = !meta.current.truncated && !meta.current.binary;
  const findable = editorFindable(() => view.current, () => editable);
  const find = useFind(editable ? findable : { ...findable, replace: undefined }, { onClose: () => view.current?.focus() });
  // Escape in the editor closes CodeMirror's (hidden) panel, and with it the matches: the bar goes too.
  const findOpen = useRef(find.open);
  findOpen.current = find.open;
  const closeFind = useRef(find.request);
  closeFind.current = find.request;

  useEffect(
    () =>
      registerWindowActions(win.id, {
        save,
        openExternally: file ? () => cmd.openPath(file) : undefined,
        // The menu bar owns ⌘F ⌘G ⇧⌘G, so CodeMirror's own bindings for them don't fire.
        find: find.request,
      }),
    [win.id, save, file, find.request],
  );

  // A search result opened here: its line in the middle, the text found selected, and ⌘G finds it again.
  const reveal = win.state.reveal as { line: number; column: number | null; text: string | null; at: number } | undefined;
  const revealed = useRef(0);
  useEffect(() => {
    const v = view.current;
    if (!v || !loaded || !reveal || reveal.at === revealed.current) return;
    revealed.current = reveal.at;
    const line = v.state.doc.line(Math.min(Math.max(1, reveal.line), v.state.doc.lines));
    let from = line.from;
    let to = line.from;
    if (reveal.text) {
      const hay = line.text.toLowerCase();
      const needle = reveal.text.toLowerCase();
      const near = reveal.column ? hay.indexOf(needle, Math.max(0, reveal.column - 3)) : -1;
      const at = near >= 0 ? near : hay.indexOf(needle);
      if (at >= 0) (from = line.from + at), (to = from + reveal.text.length);
      shareFindQuery(reveal.text);
    }
    v.dispatch({ selection: EditorSelection.range(from, to), effects: EditorView.scrollIntoView(from, { y: "center" }) });
    v.focus();
  }, [loaded, reveal?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  // What the title bar / status bar shows for this window.
  const m = meta.current;
  const label =
    notice ??
    (dirty ? "Edited" : m.truncated ? "Read-only (truncated)" : m.binary ? "Read-only (binary)" : !file ? "Empty" : `${lines} lines · ${formatBytes(m.size)}`);
  // The key says which state it is: a new key animates, line counts update in place.
  const key = notice ? "notice" : dirty ? "edited" : m.truncated || m.binary ? "readonly" : "info";
  useEffect(
    () => setWindowStatus(win.id, loaded || notice ? { label, key, dirty } : null),
    [win.id, label, key, dirty, loaded, notice],
  );
  useEffect(() => () => setWindowStatus(win.id, null), [win.id]);

  return (
    <div className="textwin">
      {conflict && (
        <Callout
          banner
          compact
          tone="warning"
          actions={
            <>
              <Button size="sm" onClick={() => void load()}>
                Reload
              </Button>
              <Button size="sm" onClick={() => void keepMine()}>
                Keep Mine
              </Button>
            </>
          }
        >
          This file changed on disk.
        </Callout>
      )}
      {find.bar}
      {error && <EmptyState compact icon="exclamationmark.triangle.fill">{error}</EmptyState>}
      <div className="textwin-editor" ref={host} />
    </div>
  );
}
