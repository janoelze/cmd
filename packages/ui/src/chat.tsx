// A conversation with an agent that acts (docs/51): what the person asked, what the
// agent says, the steps it takes and the approvals it waits for, newest last, in a View that
// keeps the end in sight while it streams. Rows, not bubbles: cmd is a workbench.
//
//   ChatMessage   the person's request (on a recess) or the agent's answer (plain, streaming)
//   ChatStep      one step, quiet beside the messages: a small icon (a spinner while it runs),
//                 its "why", the window it is about, its time; a click shows what it did
//   ChatApproval  a step waiting for the person: what it wants to do in words and exactly,
//                 Allow / Deny / Deny and Say Why
//   ChatLog       the column they stand in
//   ChatComposer  the prompt's place under the conversation, lined like a toolbar
//   useStickToEnd a scroller that follows new content unless the person scrolled up

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Button, IconButton, LinkButton } from "./button.tsx";
import { TextField } from "./fields.tsx";
import { Inline, Stack, Text } from "./frame.tsx";
import { ICON, iconNode } from "./icon.tsx";
import { Callout, CodeBlock } from "./layout.tsx";
import { Spinner } from "./status.tsx";

const cls = (...c: (string | false | undefined | null)[]) => c.filter(Boolean).join(" ");

/**
 * A message: the person's request, or what the agent says (`streaming`: a caret while it grows).
 * Children may be rendered Markdown. Its text is selectable; `copy` is what Copy under it puts on
 * the clipboard (the Markdown as written), shown on hover.
 */
export function ChatMessage({ from, streaming, copy, children }: { from: "person" | "agent"; streaming?: boolean; copy?: string; children: ReactNode }) {
  return (
    <div className="ui-chat-msg-row" data-from={from}>
      <div className="ui-chat-msg" data-from={from} data-streaming={streaming || undefined}>
        {children}
      </div>
      {copy && !streaming && <CopyButton text={copy} />}
    </div>
  );
}

/** Copy: puts `text` on the clipboard, and says so with a check for a moment. */
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1200);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <div className="ui-chat-msg-actions">
      <IconButton size="sm" icon={done ? "checkmark" : "doc.on.doc"} label={done ? "Copied" : "Copy"} onClick={() => void navigator.clipboard.writeText(text).then(() => setDone(true), () => {})} />
    </div>
  );
}

export type ChatStepState = "running" | "waiting" | "done" | "failed" | "denied";

/**
 * One step the agent took, drawn quieter than the conversation: `icon` (an SF Symbol; a spinner
 * while it runs, a warning when it failed), `title` (its why),
 * `target` (a chip for the window it is about; clicking it goes there), `time` at the end. With
 * `children`, a click opens them under the row (the input and result). `quiet`: a step that only looked.
 */
export function ChatStep({ icon, title, state, target, onTarget, time, quiet, children }: { icon: string; title: ReactNode; state: ChatStepState; target?: ReactNode; onTarget?: () => void; time?: ReactNode; quiet?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ui-chat-step" data-state={state} data-quiet={quiet || undefined} data-open={open || undefined}>
      <div className={cls("ui-chat-step-row", children != null && "has-detail")} onClick={children != null ? () => setOpen(!open) : undefined}>
        <span className="ui-chat-step-icon">{state === "running" ? <Spinner size={10} /> : iconNode(state === "failed" ? "exclamationmark.triangle" : icon, ICON.small)}</span>
        <span className="ui-chat-step-title">{title}</span>
        {target != null && (
          <button
            type="button"
            className="ui-chat-step-target"
            onClick={(e) => {
              e.stopPropagation();
              onTarget?.();
            }}
            disabled={!onTarget}
          >
            {target}
          </button>
        )}
        {time != null && <span className="ui-chat-step-time">{time}</span>}
        {children != null && <span className="ui-chat-step-twisty">{iconNode(open ? "chevron.down" : "chevron.right", ICON.small)}</span>}
      </div>
      {open && <div className="ui-chat-step-detail">{children}</div>}
    </div>
  );
}

/**
 * A step waiting for the person: `title` says what it wants in words, `exact` shows exactly what
 * would happen (the text to type and where). Allow, Deny, or Deny and Say Why (a line for the agent);
 * with `always` (what it would remember, "commands starting “pnpm test”"), also Always Allow that here.
 */
export function ChatApproval({ title, exact, always, onAnswer, busy }: { title: ReactNode; exact?: ReactNode; always?: string; onAnswer: (allow: boolean, reason?: string, remember?: boolean) => void; busy?: boolean }) {
  const [why, setWhy] = useState<string | null>(null);
  return (
    <Callout tone="accent" icon="hand.raised" title={title}>
      <Stack gap={2}>
        {exact != null && <CodeBlock>{exact}</CodeBlock>}
        {why === null ? (
          <>
            <Inline gap={2}>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => onAnswer(true)}>
                Allow
              </Button>
              <Button size="sm" disabled={busy} onClick={() => onAnswer(false)}>
                Deny
              </Button>
              <LinkButton tone="dim" disabled={busy} onClick={() => setWhy("")}>
                Deny and Say Why…
              </LinkButton>
            </Inline>
            {always && (
              <Inline>
                <LinkButton tone="dim" disabled={busy} onClick={() => onAnswer(true, undefined, true)}>
                  Always allow {always} here
                </LinkButton>
              </Inline>
            )}
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onAnswer(false, why.trim() || undefined);
            }}
          >
            <Inline gap={2}>
              <TextField size="sm" fill autoFocus value={why} onChange={setWhy} placeholder="What to do instead" aria-label="Why not" />
              <Button size="sm" type="submit" disabled={busy}>
                Deny
              </Button>
            </Inline>
          </form>
        )}
      </Stack>
    </Callout>
  );
}

/** The conversation's column: messages and steps, newest last, with room at its end for the last message's Copy. */
export function ChatLog({ children }: { children: ReactNode }) {
  return <div className="ui-chat-log">{children}</div>;
}

/** Under the conversation: the prompt and what goes with it, on the toolbar's colour with its line on top. */
export function ChatComposer({ children }: { children: ReactNode }) {
  return <div className="ui-chat-composer">{children}</div>;
}

/** A quiet line in the conversation: Stopped, an error, how long a turn took. */
export function ChatNote({ tone, children }: { tone?: "danger"; children: ReactNode }) {
  return (
    <Text size="sm" tone={tone === "danger" ? "danger" : "dim"}>
      {children}
    </Text>
  );
}

/**
 * Keeps a scroller at its end while content grows, unless the person scrolled up; `toEnd` goes
 * back down (after sending). `deps` change when content does.
 */
export function useStickToEnd(ref: RefObject<HTMLElement | null>, deps: unknown[]): { atEnd: boolean; toEnd: () => void } {
  const stick = useRef(true);
  const [atEnd, setAtEnd] = useState(true);
  const toEnd = useCallback(() => {
    stick.current = true;
    setAtEnd(true);
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ref]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const end = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      stick.current = end;
      setAtEnd(end);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { atEnd, toEnd };
}
