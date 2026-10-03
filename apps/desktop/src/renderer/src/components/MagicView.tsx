// Magic window (docs/12-magic-windows.md): a request in, a live widget or a
// terminal command out. Empty, the window is one prompt field. While the agent
// works, its steps show as a quiet list and the widget streams in. Finished,
// the widget runs in a sandboxed frame (cmd-widget://, see the main process),
// fed with theme tokens and its source's data; a prompt line at the bottom
// refines it.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { widgetTokens, type AppWindow, type MagicState, type MagicStep } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { copy, openPath } from "../actions.ts";
import { resetMagic, useMagicLive, type MagicLive } from "../magic.ts";
import { useStoreValue } from "../store.ts";
import { useTheme } from "../themes/registry.ts";
import { setWindowStatus } from "../windowActions.ts";
import { ago } from "../model.ts";
import { ICON, Symbol } from "./Symbol.tsx";
import "./magic.css";

const EXAMPLES = ["show my VPN connection status", "weather in Lisbon this week", "how full is my disk", "my open pull requests on GitHub", "a 25 minute focus timer"];

export function MagicView({ win, focused }: { win: AppWindow; focused: boolean }) {
  const s = win.state as MagicState;
  const live = useMagicLive(win.id);
  const working = s.phase === "working";
  const now = useNow(s.source ? 5000 : 0);

  // Status in the title bar: working, how fresh the data is, or a stale source.
  const dataAt = live.data?.at ?? s.lastData?.at;
  useEffect(() => {
    let status: Parameters<typeof setWindowStatus>[1] = null;
    if (working) status = { label: live.header ? "Drawing…" : "Working…", key: "working" };
    else if (live.data?.error) status = { label: "Stale", key: "stale" };
    else if (s.phase === "ready" && s.source && dataAt) status = { label: `Updated ${ago(dataAt, now)}`, key: "updated" };
    setWindowStatus(win.id, status);
  }, [win.id, working, live.header, live.data?.error, s.phase, s.source, dataAt, now]);
  useEffect(() => () => setWindowStatus(win.id, null), [win.id]);

  const run = (prompt: string) => {
    resetMagic(win.id);
    void cmd.call("magic.run", { id: win.id, prompt }).catch((e: Error) => console.error("magic.run", e));
  };

  if (s.phase === "empty" || (s.phase === "error" && !s.html && !s.command)) {
    return <PromptPane focused={focused} error={s.phase === "error" ? s.error : undefined} initial={s.prompt} onSubmit={run} />;
  }
  return (
    <div className="magic">
      {working && !live.body ? (
        <Progress state={s} live={live} onStop={() => void cmd.call("magic.cancel", { id: win.id })} />
      ) : s.kind === "terminal" && !working ? (
        <TerminalOffer win={win} command={s.command ?? ""} />
      ) : (
        <WidgetFrame win={win} html={working ? (live.body ?? "") : (s.html ?? "")} streaming={working} data={live.data?.data ?? s.lastData?.data} />
      )}
      {s.error && !working && <div className="magic-error" title={s.error}>{s.error}</div>}
      {!working && <RefineBar focused={focused} onSubmit={run} onRefresh={s.source ? () => void cmd.call("magic.refresh", { id: win.id }) : undefined} />}
      {working && live.body !== undefined && <div className="magic-drawing">Drawing…<button className="btn" onClick={() => void cmd.call("magic.cancel", { id: win.id })}>Stop</button></div>}
    </div>
  );
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

function Progress({ state, live, onStop }: { state: MagicState; live: MagicLive; onStop: () => void }) {
  const last = state.history?.at(-1) ?? state.prompt;
  return (
    <div className="magic-progress">
      <div className="magic-request">✦ {last}</div>
      <ol className="magic-steps">
        {live.steps.map((st) => (
          <StepRow key={st.id} step={st} />
        ))}
        {live.header ? (
          <li className="magic-step">
            <span className="magic-light working" />
            <span className="magic-why">{live.header.loading[0] ?? `Drawing ${live.header.title}`}</span>
          </li>
        ) : (
          !live.steps.some((x) => x.ms === undefined) && (
            <li className="magic-step">
              <span className="magic-light working" />
              <span className="magic-why">{live.steps.length ? "Thinking…" : "Reading the request…"}</span>
            </li>
          )
        )}
        {live.repair && <li className="magic-step magic-repair">↻ {live.repair}</li>}
      </ol>
      <div className="magic-progress-foot">
        <button className="btn" onClick={onStop}>
          Stop
        </button>
      </div>
    </div>
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

function WidgetFrame({ win, html, streaming, data }: { win: AppWindow; html: string; streaming: boolean; data: unknown }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const theme = useTheme();
  const fonts = useStoreValue((s) => s.settings.settings);
  const tokens = useMemo(() => widgetTokens(theme, { text: fonts["font.text"], mono: fonts["font.code"] }), [theme, fonts]);
  const post = (m: unknown) => ref.current?.contentWindow?.postMessage(m, "*");

  // Messages from the frame: only from our own frame (opaque origins all say "null").
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !e.data || typeof e.data !== "object") return;
      const m = e.data as { type?: string; url?: string; message?: string };
      if (m.type === "ready") setReady(true);
      else if (m.type === "open-url" && typeof m.url === "string" && /^https?:\/\//i.test(m.url)) void openPath(m.url);
      else if (m.type === "error") console.warn(`magic ${win.id}:`, m.message);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [win.id]);

  // The widget itself: streamed (no scripts) while working, rendered once finished.
  useEffect(() => {
    if (!ready) return;
    if (streaming) post({ type: "stream", html, tokens });
    else post({ type: "render", html, tokens, data });
    // data is sent on its own below; re-rendering on every refresh would reset the widget.
  }, [ready, html, streaming]);
  useEffect(() => {
    if (ready) post({ type: "tokens", tokens });
  }, [ready, tokens]);
  useEffect(() => {
    if (ready && !streaming && data !== undefined) post({ type: "data", data });
  }, [ready, streaming, data]);

  return <iframe ref={ref} className="magic-frame" sandbox="allow-scripts" src="cmd-widget://frame/" title={win.title} />;
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

// ── the refine line ─────────────────────────────────────

function RefineBar({ focused, onSubmit, onRefresh }: { focused: boolean; onSubmit: (p: string) => void; onRefresh?: () => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (focused && e.metaKey && e.key.toLowerCase() === "l") {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused]);
  return (
    <form
      className="magic-refine"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onSubmit(text.trim());
        setText("");
      }}
    >
      <span className="magic-mark-small">✦</span>
      <input ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder="Change something… (⌘L)" spellCheck={false} />
      {onRefresh && (
        <button type="button" className="magic-icon" title="Refresh now" onClick={onRefresh}>
          <Symbol name="arrow.clockwise" size={ICON.toolbar} />
        </button>
      )}
    </form>
  );
}
