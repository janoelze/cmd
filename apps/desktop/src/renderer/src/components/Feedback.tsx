// The feedback sheet (Help → Send Feedback…, the status bar's speech bubble):
// a kind, a message and an optional way to answer, sent by main to the
// feedback webhook (main/feedback.ts) with the version and platform if wanted.

import { useEffect, useRef, useState } from "react";
import { cmd } from "../bridge.ts";

type Kind = "idea" | "bug" | "other";
const KINDS: { id: Kind; label: string; placeholder: string }[] = [
  { id: "idea", label: "Idea", placeholder: "What would make cmd better for you?" },
  { id: "bug", label: "Bug", placeholder: "What happened, and what did you expect?" },
  { id: "other", label: "Other", placeholder: "What's on your mind?" },
];

/** ipcRenderer.invoke wraps errors: "Error invoking remote method 'x': Error: <message>". */
const reason = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function Feedback({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<Kind>("idea");
  const [message, setMessage] = useState("");
  const [contact, setContact] = useState("");
  const [includeInfo, setIncludeInfo] = useState(true);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    text.current?.focus();
    void cmd.feedbackStatus().then((s) => setUnavailable(s.available ? null : s.reason));
  }, []);

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
      await cmd.sendFeedback({ kind, message, contact: contact.trim() || undefined, includeInfo });
      setState("sent");
    } catch (err) {
      setError(reason(err));
      setState("idle");
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <form
        className="palette feedback"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => (e.preventDefault(), void send())}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          else if (e.key === "Enter" && e.metaKey) (e.preventDefault(), void send());
        }}
      >
        {state === "sent" ? (
          <div className="feedback-sent">Thanks! Your feedback is on its way.</div>
        ) : (
          <>
            <div className="feedback-head">
              <span className="feedback-title">Send Feedback</span>
              <div className="segmented">
                {KINDS.map((k) => (
                  <button key={k.id} type="button" className={kind === k.id ? "on" : ""} onClick={() => setKind(k.id)}>
                    {k.label}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              ref={text}
              className="feedback-message"
              value={message}
              placeholder={KINDS.find((k) => k.id === kind)!.placeholder}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={4000}
              rows={7}
            />
            <input
              className="feedback-contact"
              value={contact}
              placeholder="Email or Discord name, if you'd like an answer (optional)"
              onChange={(e) => setContact(e.target.value)}
              maxLength={200}
            />
            <div className="feedback-foot">
              <label className="feedback-info" title="App version, build, macOS version and architecture. Home folders are replaced by ~.">
                <input type="checkbox" checked={includeInfo} onChange={(e) => setIncludeInfo(e.target.checked)} />
                Include app version and system info
              </label>
              <span className="feedback-error">{unavailable ?? error}</span>
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn primary" disabled={!canSend} title="⌘↵">
                {state === "sending" ? "Sending…" : "Send"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
