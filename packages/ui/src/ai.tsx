// AiField: where you ask an AI for something, and watch it happen. A prompt that
// grows with what you type and a send button; the field itself shows where the
// request is, without text, so nothing around it moves:
//
//   idle      ready; the send button lights up once there is something to send
//   thinking  sent, not back yet: a comet runs along the edge, the prompt stays
//             readable but can't be edited, and Send becomes Stop
//   done      the comet fades out and the sparkle turns into a check for a moment
//   error     a danger edge, and the one line of text: why, under the field,
//             with an action (Try Again)
//
// Screen readers hear "Thinking" and "Done" (a hidden live region).
// Enter sends, Shift+Enter starts a new line, Escape stops a request in flight
// (or leaves the field), and ↑/↓ on the first/last line go through `history`,
// newest first, like a shell. With reduced motion the edge is a still accent.

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { Size } from "./button.tsx";
import { ICON, Icon } from "./icon.tsx";
import { useRowLabel } from "./labels.ts";

const cls = (...c: (string | false | undefined | null)[]) => c.filter(Boolean).join(" ");

export type AiState = "idle" | "thinking" | "done" | "error";

export interface AiFieldProps {
  value: string;
  onChange: (v: string) => void;
  /** Enter or the send button, with the trimmed prompt (never empty). */
  onSubmit: (prompt: string) => void;
  /** Stop, or Escape, while thinking; without it there is no Stop. */
  onStop?: () => void;
  state?: AiState;
  /** Why it failed, under the field while the state is "error". */
  error?: ReactNode;
  /** Beside the error: Try Again. */
  action?: ReactNode;
  /** Earlier prompts, newest first, for ↑ and ↓. */
  history?: string[];
  placeholder?: string;
  /** The kit's control sizes: sm for a toolbar or sidebar, md, lg for a sheet or an empty window. */
  size?: Size;
  /** Most lines it grows to before it scrolls. */
  maxRows?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  "aria-label"?: string;
  className?: string;
}

/** Icon sizes per field size: the mark, the send arrow, the stop square. */
const GLYPHS: Record<Size, { mark: number; send: number; stop: number }> = {
  sm: { mark: ICON.control, send: ICON.control - 1, stop: ICON.control - 3 },
  md: { mark: ICON.control + 2, send: ICON.control, stop: ICON.control - 2 },
  lg: { mark: ICON.control + 3, send: ICON.control + 1, stop: ICON.control - 1 },
};

/**
 * The comet: round blobs following the field's outline one after another, the
 * head brightest, so its tail bends around the corners (a single rigid shape
 * would swing there). Fewer, larger ones for the glow behind.
 */
const TRAIL = 24;
const GLOW = 8;
const trail = (n: number) => Array.from({ length: n }, (_, i) => <i key={i} style={{ "--i": i, "--n": n } as CSSProperties} />);

const busy = (s: AiState) => s === "thinking";

export const AiField = forwardRef<HTMLTextAreaElement, AiFieldProps>(function AiField(
  { value, onChange, onSubmit, onStop, state = "idle", error, action, history = [], placeholder = "Ask for something", size = "md", maxRows = 6, disabled, autoFocus, className, ...rest },
  ref,
) {
  const area = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => area.current!);
  const named = useRowLabel(rest["aria-label"]);
  const working = busy(state);
  const canSend = !working && !disabled && value.trim() !== "";

  // Grow with the text, up to maxRows.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 18;
    el.style.height = `${Math.min(el.scrollHeight, line * maxRows)}px`;
  }, [value, maxRows]);

  // ↑/↓ through history; -1 is what was being typed, kept aside meanwhile.
  const [recall, setRecall] = useState(-1);
  const typed = useRef("");
  useEffect(() => setRecall(-1), [history.length]);

  // The arc fades out once, on the way from busy to done or idle.
  const [settling, setSettling] = useState(false);
  const was = useRef(state);
  useEffect(() => {
    const from = was.current;
    was.current = state;
    if (!busy(from) || busy(state) || state === "error") return;
    setSettling(true);
    // As long as the fade (ui-ai-settle: twice --glide-dur, 2 × 382 ms).
    const t = setTimeout(() => setSettling(false), 800);
    return () => clearTimeout(t);
  }, [state]);

  const send = () => {
    if (!canSend) return;
    setRecall(-1);
    onSubmit(value.trim());
  };

  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      if (working && onStop) (e.preventDefault(), e.stopPropagation(), onStop());
      else el.blur();
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && history.length && !working) {
      const up = e.key === "ArrowUp";
      const before = el.value.slice(0, el.selectionStart);
      const onEdge = up ? !before.includes("\n") : !el.value.slice(el.selectionEnd).includes("\n");
      if (!onEdge) return;
      const next = Math.max(-1, Math.min(history.length - 1, recall + (up ? 1 : -1)));
      if (next === recall) return;
      e.preventDefault();
      if (recall === -1) typed.current = value;
      setRecall(next);
      onChange(next === -1 ? typed.current : history[next]!);
    }
  };

  return (
    <div className={cls("ui-ai", className)} data-size={size} data-state={state} data-settling={settling || undefined} data-disabled={disabled || undefined}>
      <div className="ui-ai-box">
      <span className="ui-ai-glow" aria-hidden>
        {trail(GLOW)}
      </span>
      <div className="ui-ai-field" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), area.current?.focus())}>
        <span className="ui-ai-edge" aria-hidden>
          {trail(TRAIL)}
        </span>
        <span className="ui-ai-mark" aria-hidden>
          <Icon name={settling && state === "done" ? "checkmark" : "sparkles"} size={GLYPHS[size].mark} weight={settling && state === "done" ? "semibold" : undefined} />
        </span>
        <textarea
          ref={area}
          rows={1}
          value={value}
          placeholder={placeholder}
          readOnly={working}
          disabled={disabled}
          autoFocus={autoFocus}
          spellCheck={false}
          aria-busy={working || undefined}
          onChange={(e) => (setRecall(-1), onChange(e.target.value))}
          onKeyDown={keys}
          {...named}
        />
        {working && onStop ? (
          <button type="button" className="ui-ai-send" data-stop aria-label="Stop" data-tip="Stop (Esc)" onClick={onStop}>
            <Icon name="stop.fill" size={GLYPHS[size].stop} />
          </button>
        ) : (
          <button type="button" className="ui-ai-send" aria-label="Send" data-tip="Send (↩)" disabled={!canSend} onMouseDown={(e) => e.preventDefault()} onClick={send}>
            <Icon name="arrow.up" size={GLYPHS[size].send} weight="semibold" />
          </button>
        )}
      </div>
      </div>
      <span className="ui-ai-sr" role="status" aria-live="polite">
        {state === "thinking" ? "Thinking" : state === "done" ? "Done" : ""}
      </span>
      {state === "error" && (error || action) && (
        <div className="ui-ai-error" role="alert">
          <span className="ui-ai-glyph">
            <Icon name="exclamationmark.triangle.fill" size={ICON.control - 1} />
          </span>
          <span className="ui-ai-error-text" data-tip={typeof error === "string" && error.length > 60 ? error : undefined}>
            {error}
          </span>
          {action && <span className="ui-ai-action">{action}</span>}
        </div>
      )}
    </div>
  );
});
