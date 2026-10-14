// Jam, a built-in widget: music as code. A Strudel pattern in an editor,
// played by an invisible sandboxed frame (main/frames.ts, jam/frame.js), and
// a prompt bar under it that asks the AI for a change (core jam/change.ts)
// while the music keeps playing.
//
//  - The toolbar: Play/Pause, Stop, Update (plays the code as it is now; also
//    Ctrl+Enter and ⌘R; marked while there are edits that aren't playing), and
//    a Visualizer listening to this window. ⌘. stops; ⌘L goes to the prompt.
//  - The code is the window's state (core windows/builtin.ts jamType),
//    saved as you type.
//  - An AI change lands in the editor line by line, the changed lines lit up for
//    a moment (editor/flash.ts; ⌘Z undoes it), and plays at once. If the frame refuses it (it doesn't evaluate, or throws when
//    queried), the error goes back to the AI, twice at most; then the edit is
//    undone and the last good code plays on.
//  - The window's sound is a Visualizer source (audio.ts publishLevels).
//  - Render to Audio: the code's first cycles into a WAV file, rendered offline
//    (faster than playing it) by a second frame made for it, while the music plays on.

import { AiField, Button, Inline, LinkButton, NumberField, Popover, Stack, Text, ToolbarButton, type AiState, ToolbarGroup, ToolbarSpacer, WindowToolbar } from "@cmd/ui";
import { useTheme } from "@cmd/ui/themes";
import { useEffect, useRef, useState } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { syntaxHighlighting } from "@codemirror/language";
import { publishLevels, type Levels } from "../../lib/audio.ts";
import { useFrame, type FrameMessage } from "../../lib/frames.ts";
import { cmd } from "../../lib/bridge.ts";
import { appTheme, minimalChange } from "../../editor/theme.ts";
import { applyAndFlash, flashChanges } from "../../editor/flash.ts";
import { syntax } from "../../editor/syntax.ts";
import { useStoreValue } from "../../lib/store.ts";
import { registerWindowActions, setWindowStatus } from "../../lib/windowActions.ts";
import type { WindowViewProps } from "../registry.ts";
import { jamControls as controls } from "./register.tsx";
import "./jam.css";

/** "undo", "undo that", "undo the last 2 changes", "go back": restored at once, without the AI. */
const UNDO = /^(?:undo|revert|go back)(?:\s+(?:that|it|this|(?:the\s+)?(?:last\s+)?(\d+|one|two|three|four|five)?\s*changes?))?[\s.!]*$/i;
const COUNTS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

/** Earlier versions kept (core windows/builtin.ts JAM_VERSIONS), newest first. */
type Version = { code: string; request: string; summary: string };
const versionsOf = (v: unknown): Version[] => (Array.isArray(v) ? (v as Version[]) : []);

/** Attempts at one request before the edit is undone. */
const ATTEMPTS = 3;

type Result = { ok: true } | { ok: false; error: string };
type Rendered = { ok: true; wav: ArrayBuffer; seconds: number } | { ok: false; error: string };

/** Where a render is saved first: beside the window's file, named after it. */
const wavPath = (file: string) => (file ? file.replace(/\.[^./]*$/, "") + ".wav" : "~/Untitled.wav");
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function JamView({ win }: WindowViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const view = useRef<EditorView | null>(null);
  const settings = useStoreValue((s) => s.settings.settings);
  const dark = useTheme().appearance === "dark";
  const [request, setRequest] = useState("");
  /** The prompt bar's AI state, and why the last request failed. */
  const [ai, setAi] = useState<AiState>("idle");
  const [aiError, setAiError] = useState<string | null>(null);
  /** Requests so far, newest first (↑ in the prompt bar). */
  const [asked, setAsked] = useState<string[]>([]);
  /** Bumped by Stop: a request whose answer comes back after it is dropped. */
  const run = useRef(0);
  const ask = useRef<HTMLTextAreaElement>(null);
  const winRef = useRef(win);
  winRef.current = win;

  const post = useFrame(frame, (m) => playerMessage(m));
  const sounds = useRef<string[]>([]);
  const levels = useRef<Levels | null>(null);
  const started = useRef(false);
  /** What plays: "paused" holds the cycle (Play resumes), "stopped" starts over. */
  const [mode, setMode] = useState<"stopped" | "playing" | "paused">("stopped");
  const pausing = useRef(false);
  /** The code last played; the editor differs from it while there are edits to play (Update). */
  const played = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Evals in flight, by id: the frame answers each.
  const evals = useRef(new Map<number, (r: Result) => void>());
  /** The render under way: its frame, mounted for it, and what to do with its answer. */
  const renderFrame = useRef<HTMLIFrameElement>(null);
  const renderJob = useRef<{ code: string; cycles: number; resolve: (r: Rendered) => void } | null>(null);
  /** Cycles a second at the tempo last played, for the render's length in seconds. */
  const [cps, setCps] = useState(0.5);
  const [cycles, setCycles] = useState(8);
  const [renderOpen, setRenderOpen] = useState(false);
  const [rendering, setRendering] = useState(false);

  const renderButton = useRef<HTMLButtonElement>(null);
  const nextId = useRef(1);
  const ready = useRef<Promise<void>>(null as never);
  const markReady = useRef<() => void>(() => {});
  if (!ready.current) ready.current = new Promise((r) => (markReady.current = r));

  const evaluate = async (code: string): Promise<Result> => {
    await ready.current;
    const id = nextId.current++;
    const r = await new Promise<Result>((resolve) => {
      evals.current.set(id, resolve);
      post({ type: "eval", id, code });
    });
    if (r.ok) {
      played.current = code;
      setDirty(view.current?.state.doc.toString() !== code);
    }
    return r;
  };

  // The file it was opened from or saved to (.strudel); untitled, the code lives in the window's state.
  const file = typeof win.state.path === "string" ? win.state.path : "";
  const fileRef = useRef(file);
  fileRef.current = file;
  /** The file's text as last read or saved; the editor differs from it while there are unsaved changes. */
  const savedText = useRef<string | null>(null);
  const unsaved = useRef(false);
  type Action = { run: () => void; title: string };
  const lastStatus = useRef<{ label: string; key: string; action?: Action }>({ label: "Stopped", key: "stopped" });
  const status = (label: string, key: string, action?: Action) => {
    lastStatus.current = { label, key, action };
    setWindowStatus(win.id, { label, key, dirty: unsaved.current, action });
  };
  const markUnsaved = (text: string) => {
    const now = !!fileRef.current && savedText.current !== null && text !== savedText.current;
    if (now === unsaved.current) return;
    unsaved.current = now;
    status(lastStatus.current.label, lastStatus.current.key, lastStatus.current.action);
  };

  /** ⌘S: to its file, or, untitled, to one the save panel asks for (it becomes the window's). */
  const save = async () => {
    const v = view.current;
    if (!v) return;
    const target = fileRef.current || (await cmd.chooseSavePath("~/Untitled.strudel"));
    if (!target) return;
    const text = v.state.doc.toString();
    try {
      await cmd.call("fs.write", { path: target, text });
      savedText.current = text;
      if (!fileRef.current) {
        fileRef.current = target;
        await cmd.call("window.update", { id: win.id, state: { path: target } });
      }
      markUnsaved(v.state.doc.toString());
    } catch (e) {
      status(`Couldn't save: ${(e as Error).message}`, "error");
    }
  };

  /** Render to Audio: a save panel, then the frame renders the editor's code offline. */
  const render = async () => {
    const v = view.current;
    if (!v || renderJob.current) return;
    setRenderOpen(false);
    const target = await cmd.chooseSavePath(wavPath(fileRef.current));
    if (!target) return;
    const code = v.state.doc.toString();
    const r = new Promise<Rendered>((resolve) => (renderJob.current = { code, cycles, resolve }));
    setRendering(true); // mounts the frame; it asks for the job once it's ready
    status("Rendering…", "rendering");
    try {
      const done = await r;
      if (!done.ok) return status(`Couldn't render: ${done.error}`, "error");
      await cmd.writeFile(target, new Uint8Array(done.wav));
      status(`Saved ${baseName(target)}`, "rendered", { run: () => cmd.revealPath(target), title: "Show in Finder" });
    } catch (e) {
      status(`Couldn't render: ${(e as Error).message}`, "error");
    } finally {
      renderJob.current = null;
      setRendering(false);
    }
  };

  const play = async () => {
    const v = view.current;
    if (!v) return;
    const r = await evaluate(v.state.doc.toString());
    if (!r.ok) status(r.error, "error");
  };
  const stop = () => {
    pausing.current = false;
    post({ type: "stop" });
  };
  const togglePlay = () => {
    if (mode === "playing") {
      pausing.current = true;
      post({ type: "pause" });
    } else if (mode === "paused" && !dirty) post({ type: "resume" });
    else void play();
  };

  /** The AI's change, tried until the frame takes it; undone if it never does. */
  const change = async (text: string) => {
    const v = view.current;
    if (!v || !text || ai === "thinking") return;
    const id = ++run.current;
    const current = () => run.current === id;
    setAsked((h) => [text, ...h.filter((x) => x !== text)].slice(0, 50));
    setAiError(null);
    const before = v.state.doc.toString();
    const versions = versionsOf(winRef.current.state.versions);
    const saveVersions = (next: Version[]) => void cmd.call("window.update", { id: win.id, state: { versions: next.slice(0, 10), code: v.state.doc.toString() } }).catch(() => {});

    // Plain undo: the version before the last change(s), at once.
    const undo = UNDO.exec(text);
    if (undo) {
      const n = Math.max(1, Number(undo[1]) || COUNTS[undo[1]?.toLowerCase() ?? ""] || 1);
      const target = versions[n - 1];
      if (!target) return setAi("error"), setAiError(versions.length ? `Only ${versions.length} change${versions.length === 1 ? "" : "s"} to undo` : "Nothing to undo yet");
      applyAndFlash(v, target.code);
      const r = await evaluate(target.code);
      if (!r.ok) return setAi("error"), setAiError(r.error);
      saveVersions(versions.slice(n));
      setAi("done");
      setRequest("");
      status(n === 1 ? `Undid “${target.request}”` : `Undid ${n} changes`, "ai");
      return;
    }

    setAi("thinking");
    let failed: { code: string; error: string } | undefined;
    try {
      for (let i = 0; i < ATTEMPTS; i++) {
        const answer = await cmd.call("jam.change", { code: before, request: text, sounds: sounds.current, history: versions, failed });
        if (!current()) return;
        applyAndFlash(v, answer.code);
        const r = await evaluate(answer.code);
        if (!current()) return;
        if (r.ok) {
          setAi("done");
          setRequest("");
          if (answer.summary) status(answer.summary, "ai");
          saveVersions([{ code: before, request: text, summary: answer.summary }, ...versions]);
          return;
        }
        failed = { code: answer.code, error: r.error };
      }
      // Never played: back to what was playing.
      const edit = minimalChange(v.state.doc.toString(), before);
      if (edit) v.dispatch({ changes: edit, userEvent: "input.ai" });
      setAi("error");
      setAiError(`Couldn't make that play: ${failed?.error ?? "unknown error"}`);
    } catch (e) {
      if (!current()) return;
      setAi("error");
      setAiError((e as Error).message);
    }
  };
  /** Stop: the answer is dropped when it comes, and the code stays as it is. */
  const stopAsking = () => {
    run.current++;
    setAi("idle");
  };

  // The editor, once per window. The code is saved as you type.
  useEffect(() => {
    let persist: ReturnType<typeof setTimeout> | undefined;
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: !file && typeof win.state.code === "string" ? win.state.code : "",
        extensions: [
          Prec.highest(
            keymap.of([
              { key: "Ctrl-Enter", run: () => (void play(), true) },
              { key: "Alt-Enter", run: () => (void play(), true) },
              { key: "Ctrl-.", run: () => (stop(), true) },
            ]),
          ),
          basicSetup,
          keymap.of([indentWithTab]),
          javascript(),
          flashChanges,
          EditorView.contentAttributes.of({ "aria-label": "Jam code" }),
          syntaxHighlighting(syntax),
          theme.of(appTheme(settings["font.code"], settings["font.codeSize"], dark)),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const text = u.state.doc.toString();
            setDirty(played.current !== null && text !== played.current);
            // A file is saved with ⌘S; untitled, the code is kept in the window's state as you type.
            if (fileRef.current) return markUnsaved(text);
            clearTimeout(persist);
            persist = setTimeout(() => void cmd.call("window.update", { id: win.id, state: { code: text } }).catch(() => {}), 500);
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      clearTimeout(persist);
      v.destroy();
      view.current = null;
    };
  }, [win.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    view.current?.dispatch({ effects: theme.reconfigure(appTheme(settings["font.code"], settings["font.codeSize"], dark)) });
  }, [settings, dark]);

  // Opened from a file: read it into the editor.
  useEffect(() => {
    if (!file || savedText.current !== null) return;
    void cmd.call("fs.read", { path: file }).then(
      (r) => {
        const v = view.current;
        if (!v || savedText.current !== null) return;
        savedText.current = r.text;
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: r.text } });
      },
      (e: Error) => status(`Couldn't open: ${e.message}`, "error"),
    );
  }, [file]); // eslint-disable-line react-hooks/exhaustive-deps

  // Untitled code changed from elsewhere (the CLI, another view): merged in place.
  useEffect(() => {
    const v = view.current;
    const code = typeof win.state.code === "string" ? win.state.code : null;
    if (!v || code === null || fileRef.current) return;
    const edit = minimalChange(v.state.doc.toString(), code);
    if (edit && !v.hasFocus) v.dispatch({ changes: edit });
  }, [win.state.code]);

  // The frames' messages (lib/frames.ts): the renderer's, while a render runs; the player's.
  const postRender = useFrame(renderFrame, (m) => {
    const job = renderJob.current;
    if (!job) return;
    if (m.type === "ready") postRender({ type: "render", id: 1, code: job.code, cycles: job.cycles });
    else if (m.type === "rendered") job.resolve(m.ok && m.wav instanceof ArrayBuffer ? { ok: true, wav: m.wav, seconds: typeof m.seconds === "number" ? m.seconds : 0 } : { ok: false, error: typeof m.error === "string" ? m.error : "Didn't render" });
  });
  function playerMessage(fm: FrameMessage) {
    const m = fm as { type?: string; id?: number; ok?: boolean; error?: string | null; started?: boolean; sounds?: unknown; cps?: number | null; t?: Uint8Array<ArrayBuffer>; l?: Uint8Array<ArrayBuffer>; r?: Uint8Array<ArrayBuffer> };
    if (m.type === "levels" && m.t && m.l && m.r) levels.current = { t: m.t, l: m.l, r: m.r };
    else if (m.type === "ready") {
      if (Array.isArray(m.sounds)) sounds.current = m.sounds.filter((s): s is string => typeof s === "string");
      markReady.current();
    } else if (m.type === "evaluated" && typeof m.id === "number") {
      evals.current.get(m.id)?.(m.ok ? { ok: true } : { ok: false, error: m.error ?? "Didn't play" });
      evals.current.delete(m.id);
    } else if (m.type === "state") {
      if (typeof m.cps === "number" && m.cps > 0) setCps(m.cps);
      started.current = !!m.started;
      const next = m.started ? "playing" : pausing.current ? "paused" : "stopped";
      if (m.started) pausing.current = false;
      setMode(next);
      if (m.error) status(m.error, "error");
      else status(next === "playing" ? "Playing" : next === "paused" ? "Paused" : "Stopped", next);
    }
  }
  useEffect(() => () => setWindowStatus(win.id, null), [win.id]);

  // Menu, commands (⌘R plays, ⌘. stops, ⌘L asks), and the window's sound for Visualizers.
  const latest = useRef({ play, stop, change, save });
  latest.current = { play, stop, change, save };
  const openRender = () => !renderJob.current && setRenderOpen(true);
  useEffect(() => {
    const focusAsk = () => ask.current?.focus();
    const c = { play: () => void latest.current.play(), stop: () => latest.current.stop(), ask: focusAsk, save: () => void latest.current.save(), render: openRender };
    controls.set(win.id, c);
    const offActions = registerWindowActions(win.id, { refresh: c.play, stop: c.stop, change: focusAsk, save: c.save });
    const offLevels = publishLevels(win.id, win.title, { read: () => (started.current ? levels.current : null), listen: (on) => post({ type: "listen", on }) });
    return () => {
      controls.delete(win.id);
      offActions();
      offLevels();
      stop();
    };
  }, [win.id, win.title]);

  return (
    <div className="jam">
      <WindowToolbar>
        <ToolbarGroup>
          <ToolbarButton icon={mode === "playing" ? "pause.fill" : "play.fill"} label={mode === "playing" ? "Pause" : "Play"} showLabel onClick={togglePlay} />
          <ToolbarButton icon="stop.fill" label="Stop" shortcut="⌘." disabled={mode === "stopped"} onClick={stop} />
          <ToolbarButton icon="arrow.clockwise" label="Update" shortcut="⌘R" showLabel tone={dirty ? "accent" : undefined} disabled={!dirty} onClick={() => void play()} />
        </ToolbarGroup>
        <ToolbarSpacer />
        <ToolbarButton
          ref={renderButton}
          icon="square.and.arrow.down"
          label="Render to Audio"
          priority={2}
          pressed={renderOpen}
          disabled={rendering}
          onClick={() => (renderOpen ? setRenderOpen(false) : openRender())}
        />
        <ToolbarButton
          icon="waveform"
          label="Open Visualizer"
          priority={1}
          onClick={() => void cmd.call("window.open", { kind: "visualizer", input: { source: `window:${win.id}` }, workspaceId: win.workspaceId }).catch(() => {})}
        />
      </WindowToolbar>
      <Popover anchor={renderButton} open={renderOpen} onClose={() => setRenderOpen(false)} align="end" width={260} label="Render to Audio">
        <Stack gap={2} pad={3}>
          <Inline justify="between" gap={2}>
            <Text>Length</Text>
            <NumberField label="Length" value={cycles} min={1} max={256} unit="cycles" onChange={setCycles} />
          </Inline>
          <Text tone="dim">{`About ${formatSeconds(cycles / cps)}, saved as a WAV file.`}</Text>
          <Inline justify="end">
            <Button variant="primary" onClick={() => void render()}>
              Render…
            </Button>
          </Inline>
        </Stack>
      </Popover>
      <div className="jam-editor" ref={host} />
      <iframe ref={frame} className="jam-frame" sandbox="allow-scripts" src="cmd-jam://frame/" title="Player" aria-hidden tabIndex={-1} />
      {rendering && <iframe ref={renderFrame} className="jam-frame" sandbox="allow-scripts" src="cmd-jam://frame/" title="Renderer" aria-hidden tabIndex={-1} />}
      <div className="jam-ask">
        <AiField
          ref={ask}
          value={request}
          onChange={(v) => (setRequest(v), ai !== "thinking" && ai !== "idle" && setAi("idle"))}
          onSubmit={(text) => void latest.current.change(text)}
          onStop={stopAsking}
          state={ai}
          error={aiError}
          action={<LinkButton onClick={() => void latest.current.change(request.trim() || asked[0] || "")}>Try Again</LinkButton>}
          history={asked}
          placeholder="Ask for a change: “double-time hats”, “darker bass”"
          aria-label="Ask for a change"
        />
      </div>
    </div>
  );
}

/** 16 s, 2 min 5 s. */
const formatSeconds = (s: number) => {
  const r = Math.round(s);
  return r < 60 ? `${Math.max(1, r)} s` : `${Math.floor(r / 60)} min${r % 60 ? ` ${r % 60} s` : ""}`;
};

/** The editor's theme, swapped when the font or appearance changes. */
const theme = new Compartment();
