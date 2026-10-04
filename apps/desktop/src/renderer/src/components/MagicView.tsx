// Magic window (docs/14-magic-v2.md): a request in, a live widget (or a
// terminal command) out. Empty, the window is one prompt field. While the agent
// builds, a dot-matrix animation and its current step show (every tool call too
// with magic.showSteps); the widget appears only once its frame has painted it.
// ⌘E (and "Edit Widget" in its menu) turns the window to its edit view
// (MagicEditor): changes and versions, settings, files, health. The widget
// runs in a sandboxed frame (cmd-widget://, see the main process), fed with
// theme tokens, its data and its saved cmd.state. Data that stops coming shows
// as "Stale" with the reason; problems a build left show in a line with Fix.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { requestedMedia, widgetTokens, type AppWindow, type MagicState, type MagicStep } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { copy, openLink } from "../actions.ts";
import { resetMagic, useMagicLive, type MagicLive } from "../magic.ts";
import { useStoreValue } from "../store.ts";
import { useTheme } from "../themes/registry.ts";
import { editTitle, registerWindowActions, setWindowStatus } from "../windowActions.ts";
import { ago } from "../model.ts";
import { handleEmbedMessage } from "../embed.ts";
import { DotMatrix } from "./DotMatrix.tsx";
import { ICON, Symbol } from "./Symbol.tsx";
import { MagicEditor } from "./MagicEditor.tsx";
import "./magic.css";

const EXAMPLES = ["show my VPN connection status", "weather in Lisbon this week", "how full is my disk", "my open pull requests on GitHub", "a 25 minute focus timer"];

// Which windows show their edit view (kept across remounts, not across restarts).
let editing = new Set<string>();
const editListeners = new Set<() => void>();
export function setEditing(id: string, on: boolean): void {
  if (editing.has(id) === on) return;
  editing = new Set(editing);
  if (on) editing.add(id);
  else editing.delete(id);
  for (const fn of editListeners) fn();
}
function useEditing(id: string): boolean {
  const set = useSyncExternalStore(
    (fn) => (editListeners.add(fn), () => editListeners.delete(fn)),
    () => editing,
  );
  return set.has(id);
}

export function MagicView({ win, focused }: { win: AppWindow; focused: boolean }) {
  const s = win.state as MagicState;
  const live = useMagicLive(win.id);
  const working = s.phase === "working";
  const showSteps = useStoreValue((x) => x.settings.settings["magic.showSteps"]);
  const hasData = !!(s.source || s.hasData);
  const now = useNow(hasData ? 5000 : 0);
  const widget = s.kind === "widget" && !!s.html;
  const edit = useEditing(win.id);

  // A run's progress stays up until the frame has painted the finished widget
  // with its data, so a half-built page never shows. `painted` is the HTML the
  // frame last reported as painted.
  const [painted, setPainted] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState(false);
  const settled = !working && (s.phase !== "ready" || !widget || painted === s.html);
  useEffect(() => {
    if (working) setAwaiting(true);
    else if (settled) setAwaiting(false);
  }, [working, settled]);
  useEffect(() => {
    if (!awaiting || working) return;
    const t = setTimeout(() => setAwaiting(false), 3000); // a frame that never answers doesn't keep it up
    return () => clearTimeout(t);
  }, [awaiting, working]);
  const building = working || awaiting;

  // Status in the title bar: working, how fresh the data is, or why it's stale.
  const dataAt = live.data && !live.data.error ? live.data.at : (s.health?.lastOk ?? s.lastData?.at);
  const staleWhy = live.data?.error ?? (s.health && !s.health.ok ? s.health.error : undefined);
  useEffect(() => {
    let status: Parameters<typeof setWindowStatus>[1] = null;
    const refresh = { title: "Refresh now (⌘R)", run: () => void cmd.call("magic.refresh", { id: win.id }) };
    if (building) status = { label: live.verifying ? "Checking…" : "Working…", key: "working" };
    else if (staleWhy && hasData) status = { label: `Stale · ${shortReason(staleWhy)}`, key: "stale", action: { title: `${staleWhy}\n\nRefresh now (⌘R)`, run: refresh.run } };
    else if (s.phase === "ready" && hasData && dataAt) status = { label: `Updated ${ago(dataAt, now)}`, key: "updated", action: refresh };
    setWindowStatus(win.id, status);
  }, [win.id, building, live.verifying, staleWhy, s.phase, hasData, dataAt, now]);
  useEffect(() => () => setWindowStatus(win.id, null), [win.id]);

  const asked = useMemo(() => requestedMedia(s), [s.media, s.html]);
  const allowed = useMemo(() => asked.filter((o) => s.mediaAllowed?.includes(o)), [asked, s.mediaAllowed]);
  const pending = asked.filter((o) => !s.mediaAllowed?.includes(o) && !s.mediaDenied?.includes(o));
  const asking = !building && widget && pending.length > 0;

  const run = (prompt: string) => {
    resetMagic(win.id);
    void cmd.call("magic.run", { id: win.id, prompt }).catch((e: Error) => console.error("magic.run", e));
  };

  // Change (title-bar input), Refresh, Stop and the edit view: the window's
  // menu and the View menu (⌘L, ⌘R, ⌘., ⌘E) route here, so they work while the
  // widget has the keyboard.
  const stop = () => void cmd.call("magic.cancel", { id: win.id });
  const latest = useRef({ ready: !building && s.phase !== "empty", data: hasData, working, run, empty: s.phase === "empty" });
  latest.current = { ready: !building && s.phase !== "empty", data: hasData, working, run, empty: s.phase === "empty" };
  useEffect(
    () =>
      registerWindowActions(win.id, {
        change: () => latest.current.ready && editTitle(win.id, { placeholder: "Change something…", submit: (t) => latest.current.run(t) }),
        refresh: () => latest.current.data && void cmd.call("magic.refresh", { id: win.id }),
        stop: () => latest.current.working && void cmd.call("magic.cancel", { id: win.id }),
        toggleEdit: () => !latest.current.empty && setEditing(win.id, !editing.has(win.id)),
      }),
    [win.id],
  );
  useEffect(() => {
    if (building) editTitle(win.id, null);
  }, [win.id, building]);
  useEffect(() => () => editTitle(win.id, null), [win.id]);

  // Once, the first time a widget is made here: how to change it (no button shows it).
  const [hint, setHint] = useState(false);
  const wasBuilding = useRef(false);
  useEffect(() => {
    if (building) wasBuilding.current = true;
    else if (wasBuilding.current && widget && s.phase === "ready") {
      wasBuilding.current = false;
      if (readFlag(HINT_FLAG)) return;
      writeFlag(HINT_FLAG);
      setHint(true);
      const t = setTimeout(() => setHint(false), 4500);
      return () => clearTimeout(t);
    }
  }, [building, widget, s.phase]);

  if (s.phase === "empty" || (s.phase === "error" && !s.html && !s.command && !edit)) {
    return <PromptPane focused={focused} error={s.phase === "error" ? s.error : undefined} initial={s.prompt} onSubmit={run} />;
  }
  if (edit) return <MagicEditor win={win} live={live} onRun={run} onClose={() => setEditing(win.id, false)} />;

  const problems = s.problems?.length ? s.problems : null;
  const broken = s.health && !s.health.ok && s.health.failures >= 3 && !s.health.retryAt;
  return (
    <div className={`magic${asking ? " needs-action" : ""}`}>
      {/* While a change runs, the current widget stays underneath, dimmed. */}
      {s.kind === "terminal" && !building ? (
        <TerminalOffer win={win} command={s.command ?? ""} />
      ) : widget ? (
        <WidgetFrame win={win} html={s.html!} data={live.data?.data ?? s.lastData?.data} kv={s.kv} media={allowed} onPainted={setPainted} />
      ) : null}
      {building && <Progress live={live} showSteps={showSteps} overlay={widget} />}
      {asking && <MediaRequest origins={pending} onAnswer={(allow) => void cmd.call("magic.media", { id: win.id, allow })} />}
      {!building && (s.error || problems || broken) && (
        <div className="magic-error" data-tip={[s.error, ...(problems ?? []), broken ? s.health?.error : ""].filter(Boolean).join("\n")}>
          <span className="magic-error-text">{s.error ?? (problems ? `${problems.length === 1 ? "A problem is" : `${problems.length} problems are`} left: ${problems[0]}` : `Data keeps failing: ${s.health?.error}`)}</span>
          <button className="magic-link" onClick={() => void cmd.call("magic.fix", { id: win.id })}>
            Fix
          </button>
          <button className="magic-link" onClick={() => setEditing(win.id, true)}>
            Details
          </button>
        </div>
      )}
      {working && <StopButton onStop={stop} />}
      {hint && <div className="magic-hint-flash">Right-click to change it · ⌘E to edit</div>}
    </div>
  );
}

/** "HTTP 403 (rate limited?) from api.github.com: …" → "HTTP 403 (rate limited?)". */
function shortReason(e: string): string {
  const first = e.split("\n")[0]!.replace(/^data\.ts: /, "");
  const http = /^HTTP \d+( \([^)]*\))?/.exec(first);
  return (http?.[0] ?? first).slice(0, 48);
}

function useNow(every: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!every) return;
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

// ── empty: the request ──────────────────────────────────

function PromptPane({ focused, error, initial, onSubmit }: { focused: boolean; error?: string; initial: string; onSubmit: (p: string) => void }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focused) ref.current?.focus();
  }, [focused]);
  const submit = () => text.trim() && onSubmit(text.trim());
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="magic-empty">
      <div className="magic-ask">
        <div className="magic-mark">✦</div>
        <textarea
          ref={ref}
          className="magic-input"
          rows={2}
          placeholder="What should this window show? A question, a URL, some JSON, a command…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
        />
        {error && <div className="magic-error-inline">{error}</div>}
        <div className="magic-examples">
          {EXAMPLES.map((x) => (
            <button key={x} className="magic-chip" onClick={() => onSubmit(x)}>
              {x}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── working: the agent's steps ──────────────────────────

/** What the agent is doing, in its own few words (each step's `why`), newest last. */
function messagesOf(live: MagicLive): string[] {
  const out: string[] = [];
  for (const st of live.steps) if (st.why && out.at(-1) !== st.why) out.push(st.why);
  if (live.verifying) out.push("Checking that it works…");
  else if (live.repair) out.push("Fixing what the check found…");
  if (!out.length) out.push("Reading the request…");
  return out;
}

/** The dot matrix over the whole window and the current step in the middle (Stop is StopButton). */
function Progress({ live, showSteps, overlay }: { live: MagicLive; showSteps: boolean; overlay: boolean }) {
  const messages = messagesOf(live);
  const current = messages.at(-1)!;
  return (
    <div className={`magic-progress${overlay ? " overlay" : ""}`}>
      <DotMatrix className="magic-matrix" />
      {showSteps && <StepList live={live} />}
      <div className="magic-status" aria-live="polite">
        <span key={`${messages.length}:${current}`}>{current}</span>
      </div>
    </div>
  );
}

/** magic.showSteps: every tool call with its command, time and (on click) output. */
export function StepList({ live, steps, className }: { live?: MagicLive; steps?: MagicStep[]; className?: string }) {
  return (
    <ol className={className ?? "magic-steps"}>
      {(steps ?? live?.steps ?? []).map((st) => (
        <StepRow key={st.id} step={st} />
      ))}
      {live?.repair && <li className="magic-step magic-repair">↻ {live.repair}</li>}
    </ol>
  );
}

function StepRow({ step }: { step: MagicStep }) {
  const [open, setOpen] = useState(false);
  const state = step.ms === undefined ? "working" : step.isError ? "failed" : "done";
  return (
    <li className={`magic-step ${state}`} onClick={() => step.output && setOpen(!open)}>
      <span className={`magic-light ${state}`} />
      <span className="magic-why">{step.why}</span>
      <span className="magic-detail">{step.detail}</span>
      {step.ms !== undefined && <span className="magic-ms">{(step.ms / 1000).toFixed(1)}s</span>}
      {open && step.output && <pre className="magic-output">{step.output}</pre>}
    </li>
  );
}

// ── ready: the widget ───────────────────────────────────

/**
 * "Play media from …?": the person allows or declines the widget's origins,
 * once per window. It covers the widget (dimmed underneath) until answered.
 */
function MediaRequest({ origins, onAnswer }: { origins: string[]; onAnswer: (allow: boolean) => void }) {
  const hosts = origins.map((o) => new URL(o).host);
  const named = hosts.length > 3 ? `${hosts.slice(0, 2).join(", ")} and ${hosts.length - 2} more` : hosts.join(", ");
  return (
    <div className="magic-overlay">
      <div className="magic-media" role="alertdialog" aria-label="Allow media" data-tip={hosts.join("\n")}>
        <div className="magic-media-title">Play media from {named}?</div>
        <div className="magic-media-text">This widget streams audio, video or images from the web. They stay blocked until you allow them.</div>
        <div className="magic-row">
          <button className="btn" onClick={() => onAnswer(false)}>
            Don't Allow
          </button>
          <button className="btn primary" onClick={() => onAnswer(true)}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

/** The frame's URL decides its CSP (main process), so a new set of allowed origins loads a new frame.
 *  So does new HTML: its scripts run at the page's top level, and a second set in the same page
 *  would collide with the first's let/const (and leave its timers and listeners running). */
export function WidgetFrame({ media, ...props }: { win: AppWindow; html: string; data: unknown; kv?: Record<string, unknown>; media: string[]; onPainted?: (html: string) => void }) {
  const [src, setSrc] = useState<string | null>(media.length ? null : "cmd-widget://frame/");
  const key = media.join(" ");
  useEffect(() => {
    let live = true;
    if (!key) setSrc("cmd-widget://frame/");
    else void cmd.widgetFrame(key.split(" ")).then((u) => live && setSrc(u));
    return () => void (live = false);
  }, [key]);
  return src ? <Frame key={`${src}\n${props.html}`} src={src} {...props} /> : <div className="magic-frame" />;
}

function Frame({ win, src, html, data, kv, onPainted }: { win: AppWindow; src: string; html: string; data: unknown; kv?: Record<string, unknown>; onPainted?: (html: string) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  // Hidden until the page reports the current HTML painted (host.js "rendered").
  const [painted, setPainted] = useState<string | null>(null);
  const sent = useRef<string | null>(null);
  const paintedRef = useRef(onPainted);
  paintedRef.current = onPainted;
  const kvRef = useRef(kv);
  kvRef.current = kv;
  const markPainted = (h: string) => {
    setPainted(h);
    paintedRef.current?.(h);
  };
  const theme = useTheme();
  const fonts = useStoreValue((s) => s.settings.settings);
  const tokens = useMemo(() => widgetTokens(theme, { text: fonts["font.text"], mono: fonts["font.code"] }), [theme, fonts]);
  const post = (m: unknown) => ref.current?.contentWindow?.postMessage(m, "*");

  // cmd.state.set from the widget: kept in the window's state by the core, a moment later (sliders send many).
  const pendingState = useRef(new Map<string, unknown>());
  const stateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushState = () => {
    stateTimer.current = null;
    for (const [key, value] of pendingState.current) void cmd.call("magic.state", { id: win.id, key, value }).catch(() => {});
    pendingState.current.clear();
  };
  useEffect(() => () => void (stateTimer.current && (clearTimeout(stateTimer.current), flushState())), []);

  // Messages from the frame: only from our own frame (opaque origins all say "null").
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !e.data || typeof e.data !== "object") return;
      const m = e.data as { type?: string; url?: string; message?: string; key?: unknown; value?: unknown };
      if (m.type === "ready") setReady(true);
      else if (m.type === "rendered") sent.current !== null && markPainted(sent.current);
      else if (handleEmbedMessage(ref.current!, m)) return;
      else if (m.type === "open-url" && typeof m.url === "string" && /^https?:\/\//i.test(m.url)) openLink(m.url);
      else if (m.type === "state-set" && typeof m.key === "string") {
        pendingState.current.set(m.key, m.value ?? null);
        stateTimer.current ??= setTimeout(flushState, 800);
      } else if (m.type === "error") console.warn(`magic ${win.id}:`, m.message);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [win.id]);

  // The finished widget, rendered once per HTML; the page says when it has painted.
  useEffect(() => {
    if (!ready) return;
    sent.current = html;
    post({ type: "render", html, tokens, data, kv: kvRef.current ?? {} });
    // Never stay hidden if the page doesn't answer.
    const t = setTimeout(() => markPainted(html), 1500);
    return () => clearTimeout(t);
    // data is sent on its own below; re-rendering on every refresh would reset the widget.
  }, [ready, html]);
  useEffect(() => {
    if (ready) post({ type: "tokens", tokens });
  }, [ready, tokens]);
  useEffect(() => {
    if (ready && data !== undefined) post({ type: "data", data });
  }, [ready, data]);

  return <iframe ref={ref} className={`magic-frame${painted === html ? "" : " unpainted"}`} data-embed sandbox="allow-scripts" src={src} title={win.title} />;
}

// ── ready: a command to run ─────────────────────────────

function TerminalOffer({ win, command }: { win: AppWindow; command: string }) {
  const runIt = async () => {
    const t = await cmd.call("window.open", { kind: "terminal", input: {}, spaceId: win.spaceId });
    // Typed, not run: the person presses Return.
    await cmd.call("pane.write", { paneId: t.id, data: command });
    await cmd.call("window.close", { id: win.id });
  };
  return (
    <div className="magic-terminal">
      <div className="magic-command">
        <span className="magic-prompt">❯</span> {command}
      </div>
      <div className="magic-row">
        <button className="btn primary" onClick={() => void runIt()}>
          Open in Terminal
        </button>
        <button className="btn" onClick={() => copy(command)}>
          Copy
        </button>
      </div>
      <div className="magic-hint">Opens a terminal with the command typed in; press Return to run it.</div>
    </div>
  );
}

// ── stop ────────────────────────────────────────────────

/**
 * × while the window is being made, at the bottom right; there's no content
 * under it then. Change and Refresh live in the window's menu (right-click,
 * windows/builtin.tsx) and the View menu instead, so nothing covers a widget.
 */
function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <button className="magic-stop" data-tip="Stop" data-tip-key="⌘." aria-label="Stop" onClick={onStop}>
      <Symbol name="xmark" size={ICON.small} />
    </button>
  );
}

const HINT_FLAG = "cmd.magic.changeHintShown";
const readFlag = (k: string) => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return true; // can't remember it: don't show it at all
  }
};
const writeFlag = (k: string) => {
  try {
    localStorage.setItem(k, "1");
  } catch {}
};
