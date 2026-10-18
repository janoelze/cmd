// Asking the person before something happens on their behalf (docs/55): one sheet for every
// approval, whoever asks (an agent's tool call, the Operator, a web page wanting the camera, a
// device pairing, a risky action). Who asks, what in words, why in theirs, exactly what would
// happen, and how long the answer holds; Return allows, Esc denies.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, ButtonGroup } from "./button.tsx";
import { Segmented } from "./choice.tsx";
import { TextField } from "./fields.tsx";
import { CodeBlock } from "./layout.tsx";
import { Dialog, Menu } from "./overlay.tsx";
import type { IconLike } from "./icon.tsx";

/** How long a Return right after the sheet appears is ignored: an Enter already being typed into a terminal mustn't approve unread. */
const GUARD_MS = 300;

/** The person's answer: allowed or not, for how long (a scope's value), what (a choice's value), and why not, if they said. */
export interface ApprovalAnswer<S extends string = string, C extends string = string> {
  allow: boolean;
  scope?: S;
  choice?: C;
  reason?: string;
}

/**
 * The approval sheet (docs/55): opens at once over the window, dressed as one of the app's
 * window sheets, and answers one question, may *who* do *what*. `who` is the asker, in the
 * title bar (an agent's icon and name, and the workspace as context);
 * `title` says what in plain words ("Type in the terminal “tests”"), `why` is the asker's own
 * reason, in dim text under the title, and `exact` is exactly what would happen (a string shows as code:
 * the command, the URL; a node for a diff). `scopes` are how long a yes may hold, a switch in the
 * footer (Once, This Session, Always; what each covers in its tooltip), the first chosen at
 * first; leave them out for a plain yes or no. `choices` are what a
 * yes allows, where there are kinds of it (a device: Control or View only), shown as a switch.
 *
 * Return allows from anywhere in the sheet but the reason field, except in its first 300 ms;
 * Esc and the scrim deny. Deny's menu has "Deny and Say Why…": a field whose text goes with the no.
 * `danger` makes Allow the danger button (a deploy). `position` says "1 of 3" when more wait;
 * `expiresAt` counts down to when the asker gives up.
 */
export function ApprovalSheet<S extends string = string, C extends string = string>({
  open = true,
  who,
  title,
  why,
  exact,
  scopes,
  choices,
  allow = "Allow",
  deny = "Deny",
  danger,
  position,
  expiresAt,
  onAnswer,
  onDismiss,
  askWhy = true,
  className,
  busy,
}: {
  /** False while it fades out (Presence). */
  open?: boolean;
  /** The asker, in the sheet's title bar: an icon, a name, and where (the workspace, Remote Access). */
  who: { icon?: IconLike; name: string; context?: string };
  title: ReactNode;
  why?: ReactNode;
  exact?: ReactNode;
  /** How long a yes may hold, as a switch in the footer (short labels; `detail`, what each covers, is its tooltip); the first is chosen at first. */
  scopes?: readonly { value: S; label: string; detail?: string }[];
  /** What a yes allows, when there is more than one way to (a device: Control or View only), shown as a switch beside Allow; the first is chosen at first. */
  choices?: readonly { value: C; label: string }[];
  allow?: string;
  deny?: string;
  danger?: boolean;
  position?: { index: number; count: number };
  /** When the asker stops waiting (ms since the epoch). */
  expiresAt?: number;
  onAnswer: (a: ApprovalAnswer<S, C>) => void;
  /** Esc, ✕ and the scrim: "not now", where that differs from Deny (a web page's ask, asked again next time). Left out, they deny. */
  onDismiss?: () => void;
  className?: string;
  /** Offer "Deny and Say Why…": for an asker that reads it (an agent), not a web page or a device. */
  askWhy?: boolean;
  busy?: boolean;
}) {
  const [scope, setScope] = useState<S | undefined>(scopes?.[0]?.value);
  const [choice, setChoice] = useState<C | undefined>(choices?.[0]?.value);
  const [menu, setMenu] = useState(false);
  const denyMore = useRef<HTMLButtonElement>(null);
  const [reason, setReason] = useState<string | null>(null);
  const shownAt = useRef(Date.now());
  const content = useRef<HTMLDivElement>(null);
  const left = useCountdown(expiresAt);
  // At the title bar's right: how long it has left, and how many wait.
  const meta = [left, position && position.count > 1 ? `${position.index} of ${position.count}` : null].filter((x): x is string => !!x);
  useEffect(() => void (shownAt.current = Date.now()), [title]);

  const say = (a: ApprovalAnswer<S, C>) => !busy && onAnswer(a);
  const yes = () => say({ allow: true, scope, choice });
  const no = () => say({ allow: false });
  const yesRef = useRef(yes);
  yesRef.current = yes;

  // Return allows from anywhere in the sheet (a focused Deny or scope too), but not while writing why.
  useEffect(() => {
    if (!open || reason !== null || menu) return;
    const onKey = (e: KeyboardEvent) => {
      const sheet = content.current?.closest(".ui-dialog");
      if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || !sheet?.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      if (Date.now() - shownAt.current >= GUARD_MS) yesRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, reason, menu]);

  return (
    <Dialog
      open={open}
      onClose={() => !busy && (onDismiss ?? no)()}
      width={480}
      position="center"
      divided
      className={className ? `ui-approval ${className}` : "ui-approval"}
      label={typeof title === "string" ? title : "Approval"}
      dismissable={!busy}
      window={{ icon: who.icon, name: who.context ? `${who.name} · ${who.context}` : who.name, status: meta.length ? meta.join("  ·  ") : undefined }}
      title={title}
      aside={
        reason === null && scopes && scopes.length > 1 && scope !== undefined ? (
          <Segmented value={scope} options={scopes.map((o) => ({ value: o.value, label: o.label, tip: o.detail }))} onChange={setScope} label="For how long" />
        ) : undefined
      }
      actions={
        reason === null ? (
          <>
            {askWhy ? (
              <ButtonGroup joined label={deny}>
                <Button disabled={busy} onClick={no}>
                  {deny}
                </Button>
                <Button ref={denyMore} icon="caret-down" disabled={busy} aria-label="More ways to deny" aria-haspopup="menu" onClick={() => setMenu(true)} />
              </ButtonGroup>
            ) : (
              <Button disabled={busy} onClick={no}>
                {deny}
              </Button>
            )}
            {askWhy && <Menu anchor={denyMore} open={menu} onClose={() => setMenu(false)} align="end" placement="above" width="content" label="More ways to deny" items={[{ label: `${deny} and Say Why…`, onSelect: () => (setMenu(false), setReason("")) }]} />}
            <Button variant={danger ? "danger" : "primary"} busy={busy} autoFocus onClick={yes}>
              {allow}
            </Button>
          </>
        ) : (
          <>
            <Button disabled={busy} onClick={() => setReason(null)}>
              Back
            </Button>
            <Button variant="primary" busy={busy} onClick={() => say({ allow: false, reason: reason.trim() || undefined })}>
              {deny}
            </Button>
          </>
        )
      }
    >
      <div ref={content} className="ui-approval-content">
        {why != null && <div className="ui-approval-why">{why}</div>}
        {exact != null && (typeof exact === "string" ? <CodeBlock tone={danger ? "danger" : undefined}>{exact}</CodeBlock> : <div className="ui-approval-exact" style={{ maxHeight: 220 }}>{exact}</div>)}
        {choices && choices.length > 1 && choice !== undefined && reason === null && (
          <div className="ui-approval-choice">
            <span className="ui-approval-choice-label">{allow}</span>
            <Segmented value={choice} options={choices} onChange={setChoice} label={allow} fill />
          </div>
        )}
        {reason !== null && (
          <form onSubmit={(e) => (e.preventDefault(), say({ allow: false, reason: reason.trim() || undefined }))}>
            <TextField fill autoFocus value={reason} onChange={setReason} placeholder="What to do instead (sent to the agent)" aria-label="Why not" />
          </form>
        )}
      </div>
    </Dialog>
  );
}

/** "Expires in 4:59", ticking; null without an end. */
function useCountdown(at: number | undefined): string | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!at) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [at]);
  if (!at) return null;
  const s = Math.max(0, Math.round((at - now) / 1000));
  return `Expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
