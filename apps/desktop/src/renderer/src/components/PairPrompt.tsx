// "Allow “iPhone” to use cmd?" (docs/13-remote-access.md, "Experience"): the
// device's name, the four words its screen shows, and three equal choices, so
// neither the safe nor the useful answer is a default to click past. Esc
// answers Don't Allow. Used by the main window's sheet and inline in Settings,
// so it talks to the core directly and not through either window's store.

import { Button } from "@cmd/ui";
import { useEffect, useRef, useState } from "react";
import type { RemotePairRequest, RemoteScope } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { Symbol } from "./Symbol.tsx";

export const scopeLabel = (s: RemoteScope) => (s === "view" ? "View only" : "Control");

export function PairPrompt({ request, autoFocus = true }: { request: RemotePairRequest; autoFocus?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(request.expiresAt - Date.now());
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => void (autoFocus && box.current?.focus()), [autoFocus]);
  useEffect(() => {
    const t = setInterval(() => setLeft(request.expiresAt - Date.now()), 1000);
    return () => clearInterval(t);
  }, [request.expiresAt]);
  const answer = (allow: boolean, scope?: RemoteScope) => {
    if (busy) return;
    setBusy(true);
    void cmd.call("remote.approve", { requestId: request.requestId, allow, scope }).catch(() => {});
  };
  const secs = Math.max(0, Math.round(left / 1000));
  return (
    <div className="pair-prompt" tabIndex={-1} ref={box} onKeyDown={(e) => e.key === "Escape" && answer(false)}>
      <Symbol name="iphone.radiowaves.left.and.right" size={28} weight="regular" className="pair-icon" />
      <div className="pair-title">Allow “{request.name}” to use cmd?</div>
      <div className="pair-sub">Make sure its screen shows these words:</div>
      <div className="pair-words">
        {request.words.map((w, i) => (
          <span key={i}>{w}</span>
        ))}
      </div>
      <div className="pair-note">
        <b>View only</b> watches terminals and reads files. <b>Control</b> can also type and change files: it is a shell on this Mac.
      </div>
      <div className="pair-foot">
        <span className="pair-expiry">
          Expires in {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}
        </span>
        <Button disabled={busy} onClick={() => answer(false)}>
          Don't Allow
        </Button>
        <Button disabled={busy} onClick={() => answer(true, "view")}>
          Allow View Only
        </Button>
        <Button disabled={busy} onClick={() => answer(true, "control")}>
          Allow Control
        </Button>
      </div>
    </div>
  );
}
