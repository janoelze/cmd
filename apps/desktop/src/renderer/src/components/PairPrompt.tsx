// "Allow “iPhone” to use cmd?" (docs/13-remote-access.md, "Experience"): the
// device's name, the four words its screen shows, and three equal choices, so
// neither the safe nor the useful answer is a default to click past. Esc
// answers Don't Allow. A sheet dressed as a window in the main window
// (PairSheet), inline in Settings (PairPrompt); both talk to the core directly
// and not through either window's store.

import { Badge, Button, Dialog, Inline, Spacer, Stack, Text } from "@cmd/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RemotePairRequest, RemoteScope } from "@cmd/protocol";
import { cmd } from "../bridge.ts";

export const scopeLabel = (s: RemoteScope) => (s === "view" ? "View only" : "Control");

/** Answering a request (once), and the seconds it has left. */
function usePair(request: RemotePairRequest) {
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(request.expiresAt - Date.now());
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
  const expires = `Expires in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  const expiry = (
    <Text size="sm" tone="dim">
      {expires}
    </Text>
  );
  const buttons = (
    <>
      <Button disabled={busy} onClick={() => answer(false)}>
        Don't Allow
      </Button>
      <Button disabled={busy} onClick={() => answer(true, "view")}>
        Allow View Only
      </Button>
      <Button disabled={busy} onClick={() => answer(true, "control")}>
        Allow Control
      </Button>
    </>
  );
  return { answer, expires, expiry, buttons };
}

/** The question, the words to compare, what each answer allows. Esc is Don't Allow. */
function PairText({ request, onEscape, autoFocus, children }: { request: RemotePairRequest; onEscape: () => void; autoFocus: boolean; children?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => void (autoFocus && box.current?.focus()), [autoFocus]);
  return (
    <div className="pair-prompt" tabIndex={-1} ref={box} style={{ outline: "none" }} onKeyDown={(e) => e.key === "Escape" && onEscape()}>
      <Stack gap="md">
        <Text strong>Allow “{request.name}” to use cmd?</Text>
        <Stack gap="sm">
          <Text tone="dim">Check that its screen shows these words:</Text>
          <Inline gap="xs" wrap>
            {request.words.map((w, i) => (
              <Badge key={i} tone="accent">
                {w}
              </Badge>
            ))}
          </Inline>
        </Stack>
        <Text size="sm" tone="dim">
          <b>View only</b> watches terminals and reads files. <b>Control</b> can also type and change files: it is a shell on this Mac.
        </Text>
        {children}
      </Stack>
    </div>
  );
}

/** In the main window, while a device waits: a sheet dressed as a window, answered only by its buttons. */
export function PairSheet({ open = true, request }: { open?: boolean; request: RemotePairRequest }) {
  const p = usePair(request);
  return (
    <Dialog open={open} onClose={() => {}} dismissable={false} width={420} position="center" className="pair-sheet" label="Allow a device" window={{ icon: "iphone.radiowaves.left.and.right", name: "Allow a Device", close: false, status: p.expires }} actions={p.buttons}>
      <PairText request={request} onEscape={() => p.answer(false)} autoFocus />
    </Dialog>
  );
}

/** Inline (Settings → Remote Access): the same, its buttons under it. */
export function PairPrompt({ request, autoFocus = true }: { request: RemotePairRequest; autoFocus?: boolean }) {
  const p = usePair(request);
  return (
    <PairText request={request} onEscape={() => p.answer(false)} autoFocus={autoFocus}>
      <Inline gap="sm" wrap>
        {p.expiry}
        <Spacer />
        {p.buttons}
      </Inline>
    </PairText>
  );
}
