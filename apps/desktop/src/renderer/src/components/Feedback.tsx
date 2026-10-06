// The feedback sheet (Help → Send Feedback…, the status bar's speech bubble):
// a kind, a message and an optional way to answer, sent by main to the
// feedback webhook (main/feedback.ts) with the version and platform if wanted.

import { Button, Callout, Checkbox, Dialog, EmptyState, Segmented, TextArea, TextField } from "@cmd/ui";
import { useEffect, useRef, useState } from "react";
import { cmd } from "../bridge.ts";
import type { CmdBridge } from "../../../preload/index.ts";
import type { FeedbackRequest } from "../../../main/feedback.ts";

type Kind = FeedbackRequest["kind"];
const KINDS: { id: Kind; label: string; placeholder: string }[] = [
  { id: "idea", label: "Idea", placeholder: "What would make cmd better for you?" },
  { id: "bug", label: "Bug", placeholder: "What happened, and what did you expect?" },
  { id: "other", label: "Other", placeholder: "What's on your mind?" },
];

/** Where feedback goes: main, through the bridge (a story passes its own). */
export type FeedbackApi = Pick<CmdBridge, "feedbackStatus" | "sendFeedback">;

/** ipcRenderer.invoke wraps errors: "Error invoking remote method 'x': Error: <message>". */
const reason = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function Feedback({
  onClose,
  initial,
  api = cmd,
}: {
  onClose: () => void;
  /** Filled in already (a bug report from an error). */
  initial?: { kind?: Kind; message?: string; contact?: string };
  api?: FeedbackApi;
}) {
  const [kind, setKind] = useState<Kind>(initial?.kind ?? "idea");
  const [message, setMessage] = useState(initial?.message ?? "");
  const [contact, setContact] = useState(initial?.contact ?? "");
  const [includeInfo, setIncludeInfo] = useState(true);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    text.current?.focus();
    void api.feedbackStatus().then((s) => setUnavailable(s.available ? null : s.reason));
  }, [api]);

  useEffect(() => {
    if (state !== "sent") return;
    const t = setTimeout(() => close.current(), 1400);
    return () => clearTimeout(t);
  }, [state]);

  const canSend = !unavailable && state === "idle" && message.trim().length > 0;
  const send = async () => {
    if (!canSend) return;
    setState("sending");
    setError(null);
    try {
      await api.sendFeedback({ kind, message, contact: contact.trim() || undefined, includeInfo });
      setState("sent");
    } catch (err) {
      setError(reason(err));
      setState("idle");
    }
  };

  if (state === "sent")
    return (
      <Dialog open onClose={onClose} width={480} position="center" label="Feedback sent" window={{ icon: "bubble.left", name: "Send Feedback" }}>
        <EmptyState icon="checkmark.circle" title="Thanks for the feedback">
          It's on its way.
        </EmptyState>
      </Dialog>
    );

  return (
    <Dialog
      open
      onClose={onClose}
      window={{ icon: "bubble.left", name: "Send Feedback" }}
      width={480}
      position="center"
      divided
      aside={
        <span data-tip="App version, build, macOS version and architecture. Home folders are replaced by ~.">
          <Checkbox checked={includeInfo} onChange={setIncludeInfo}>
            Include version and system info
          </Checkbox>
        </span>
      }
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSend} busy={state === "sending"} data-tip="Send" data-tip-key="⌘↵" onClick={() => void send()}>
            {state === "sending" ? "Sending…" : "Send"}
          </Button>
        </>
      }
    >
      {unavailable && <Callout tone="warning">{unavailable}</Callout>}
      {error && (
        <Callout tone="danger" title="Couldn't send your feedback">
          {error}
        </Callout>
      )}
      <Segmented fill label="Kind" value={kind} options={KINDS.map((k) => ({ value: k.id, label: k.label }))} onChange={setKind} />
      <TextArea ref={text} value={message} placeholder={KINDS.find((k) => k.id === kind)!.placeholder} onChange={setMessage} onSubmit={() => void send()} maxLength={4000} rows={7} />
      <TextField fill size="lg" value={contact} placeholder="Email or Discord name, if you'd like an answer" onChange={setContact} maxLength={200} />
    </Dialog>
  );
}
