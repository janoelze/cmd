// Remote access in the main window (docs/13-remote-access.md, "Experience"):
// the sheet that lets a device in (approval only ever happens here, in Settings
// or in `cmd remote pair`), the status bar indicator (its state at a glance; who
// is in, with what access, watching which windows; disconnect in one click),
// and the notifications that go with them.

import { useEffect, useRef, useState } from "react";
import type { RemotePairRequest, RemoteStatus } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { getState, useStoreValue } from "../store.ts";
import { ICON, Symbol } from "./Symbol.tsx";
import { PairPrompt, scopeLabel } from "./PairPrompt.tsx";
import { useTooltip } from "@cmd/ui";

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** A window's title by id (terminals are panes). */
export function windowTitle(id: string): string {
  const s = getState();
  return s.panes.get(id)?.title ?? s.windows.get(id)?.title ?? "a window";
}

/** The device names watching a window, if any. */
export function useWatchers(windowId: string | null): string[] {
  const sessions = useStoreValue((s) => s.remote?.sessions);
  if (!windowId || !sessions) return [];
  return [...new Set(sessions.filter((x) => x.watching.includes(windowId)).map((x) => x.name))];
}

// ── approval sheet ─────────────────────────────────────

/** The approval prompt over the main window (Settings shows it inline). */
export function PairSheet({ request }: { request: RemotePairRequest }) {
  return (
    <div className="palette-backdrop pair-backdrop">
      <div className="palette pair-sheet">
        <PairPrompt request={request} />
      </div>
    </div>
  );
}

/**
 * A phone is looking at this window (docs/13, "Experience"): a small badge, and
 * for a moment after it types here, who typed. In the window's title bar, the
 * status bar (focus view has no title bars) and the sidebar row (compact).
 */
export function RemoteBadge({ id, compact = false }: { id: string | null; compact?: boolean }) {
  const watchers = useWatchers(id);
  const typed = useStoreValue((s) => (id ? s.remoteInput.get(id) : undefined));
  if (!watchers.length && !typed) return null;
  return (
    <span className={`remote-badge${typed ? " typed" : ""}`} data-tip={typed ? `${typed} typed here` : `Watched from ${watchers.join(", ")}`}>
      <Symbol name="iphone" size={ICON.small} />
      {typed && !compact && <span>typed from {typed}</span>}
    </span>
  );
}

// ── status bar indicator ───────────────────────────────

const STATE_TEXT = { off: "Off", connecting: "Connecting to the relay…", online: "Ready", error: "Can't reach the relay" } as const;

/**
 * In the status bar while remote access is on. Its colour says the state at a
 * glance: dim when ready, accent while a device is connected, pulsing while one
 * waits for approval, warning when the relay can't be reached. Its tooltip says
 * who is in and what they watch; the popover (a click) also offers Disconnect.
 */
export function RemoteIndicator() {
  const status = useStoreValue((s) => s.remote);
  const [open, setOpen] = useState<DOMRect | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const tipRef = useTooltip(() => status && <RemoteTip status={status} />);
  if (!status || (!status.enabled && !status.sessions.length)) return null;
  const names = [...new Set(status.sessions.map((s) => s.name))];
  const tone = status.requests.length ? "asking" : names.length ? "connected" : status.state === "error" ? "error" : "idle";
  const tip = status.requests.length
    ? `${status.requests[0]!.name} is waiting for approval`
    : names.length
      ? `Connected: ${names.join(", ")}`
      : `Remote access: ${STATE_TEXT[status.state]}`;
  return (
    <>
      <button
        ref={(el) => ((button.current = el), tipRef(el))}
        className={`icon-btn remote-indicator ${tone}${open ? " on" : ""}`}
        aria-label={tip}
        aria-expanded={!!open}
        onClick={() => setOpen(open ? null : button.current!.getBoundingClientRect())}
      >
        <Symbol name={names.length ? "iphone.radiowaves.left.and.right" : "iphone"} size={ICON.bar} />
      </button>
      {open && <RemotePopover at={open} status={status} onClose={() => setOpen(null)} />}
    </>
  );
}

/** The indicator's tooltip: the state, who waits, who is in and what they watch. */
function RemoteTip({ status }: { status: RemoteStatus }) {
  const { sessions, requests } = status;
  const paired = status.devices.length;
  return (
    <div className="remote-tip">
      <div className="tip-head">Remote Access · {sessions.length && status.state === "online" ? "Connected" : STATE_TEXT[status.state]}</div>
      {status.state === "error" && status.error && <div className="tip-dim">{status.error}</div>}
      {requests.map((r) => (
        <div key={r.requestId} className="remote-tip-row">
          <Symbol name="iphone" size={ICON.small} />
          <span>
            <b>{r.name}</b> is waiting for you to allow it
          </span>
        </div>
      ))}
      {sessions.map((s) => (
        <div key={s.id} className="remote-tip-row">
          <Symbol name="iphone.radiowaves.left.and.right" size={ICON.small} />
          <span>
            <b>{s.name}</b> <span className={`remote-tag${s.scope === "control" ? " control" : ""}`}>{scopeLabel(s.scope)}</span>
            <div className="tip-dim">
              Since {clock(s.since)} · {s.watching.length ? `watching ${s.watching.map(windowTitle).join(", ")}` : "on its home screen"}
            </div>
          </span>
        </div>
      ))}
      {!sessions.length && !requests.length && <div className="tip-dim">{paired ? `No device connected. ${paired} paired.` : "No devices paired yet."}</div>}
      <div className="tip-foot">Click for options</div>
    </div>
  );
}

function RemotePopover({ at, status, onClose }: { at: DOMRect; status: RemoteStatus; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Next tick: the click that opened it mustn't close it.
    const t = setTimeout(() => (window.addEventListener("mousedown", down), window.addEventListener("keydown", key)));
    return () => (clearTimeout(t), window.removeEventListener("mousedown", down), window.removeEventListener("keydown", key));
  }, [onClose]);
  const { sessions } = status;
  const act = (fn: () => unknown) => () => (void fn(), onClose());
  // Opens upward from the status bar, its right edge at the button's.
  const right = Math.max(8, window.innerWidth - at.right);
  const paired = status.devices.length;
  return (
    <div className="remote-popover" ref={ref} style={{ bottom: window.innerHeight - at.top + 6, right }}>
      <div className="remote-pop-head">
        Remote Access · {sessions.length && status.state === "online" ? "Connected" : STATE_TEXT[status.state]}
        {status.state === "error" && status.error ? <div className="remote-pop-dim">{status.error}</div> : null}
      </div>
      {status.requests.map((r) => (
        <div key={r.requestId} className="remote-pop-row">
          <Symbol name="iphone" size={ICON.row} />
          <div className="remote-pop-text">
            <b>{r.name}</b> is waiting for you to allow it
          </div>
        </div>
      ))}
      {sessions.map((s) => (
        <div key={s.id} className="remote-pop-row">
          <Symbol name="iphone.radiowaves.left.and.right" size={ICON.row} />
          <div className="remote-pop-text">
            <div>
              <b>{s.name}</b> <span className={`remote-tag${s.scope === "control" ? " control" : ""}`}>{scopeLabel(s.scope)}</span>
            </div>
            <div className="remote-pop-dim">
              Since {clock(s.since)} · {s.watching.length ? `watching ${s.watching.map(windowTitle).join(", ")}` : "on its home screen"}
            </div>
          </div>
          <button className="btn" onClick={act(() => cmd.call("remote.disconnect", { id: s.deviceId }))}>
            Disconnect
          </button>
        </div>
      ))}
      {!sessions.length && !status.requests.length && (
        <div className="remote-pop-row remote-pop-dim">
          {paired ? `No device connected. ${paired} paired.` : "No devices paired yet."}
        </div>
      )}
      <div className="remote-pop-foot">
        {sessions.length > 0 && (
          <button className="btn" onClick={act(() => cmd.call("remote.disconnect", {}))}>
            Disconnect All
          </button>
        )}
        <button className="btn" onClick={act(() => cmd.call("remote.disable", {}))}>
          Turn Off
        </button>
        <span className="remote-pop-spacer" />
        <button className="btn" onClick={act(() => cmd.openSettings("remote/pair"))}>
          Pair a Device…
        </button>
        <button className="btn" onClick={act(() => cmd.openSettings("remote"))}>
          Settings…
        </button>
      </div>
    </div>
  );
}

// ── notifications ──────────────────────────────────────

/**
 * A pairing request while the app is in the background: a notification that
 * brings it forward (the sheet is waiting). A device connecting while someone
 * is using this Mac: say so. While the Mac sits idle, it's probably you, away
 * from it, so stay quiet.
 */
export function useRemoteNotifications(): void {
  const requests = useStoreValue((s) => s.pairRequests);
  const sessions = useStoreValue((s) => s.remote?.sessions);
  const seenRequests = useRef(new Set<string>());
  const seenSessions = useRef<Set<string> | null>(null);
  const lastInput = useRef(Date.now());

  useEffect(() => {
    const mark = () => (lastInput.current = Date.now());
    window.addEventListener("keydown", mark, true);
    window.addEventListener("mousedown", mark, true);
    return () => (window.removeEventListener("keydown", mark, true), window.removeEventListener("mousedown", mark, true));
  }, []);

  useEffect(() => {
    for (const r of requests) {
      if (seenRequests.current.has(r.requestId)) continue;
      seenRequests.current.add(r.requestId);
      if (document.hasFocus()) continue;
      cmd.notify({ tag: `remote-pair-${r.requestId}`, title: `Allow “${r.name}” to use cmd?`, body: `Check that it shows: ${r.words.join(" ")}`, sound: "default", paneId: null });
      cmd.bounce();
    }
    for (const id of seenRequests.current) if (!requests.some((r) => r.requestId === id)) cmd.closeNotification(`remote-pair-${id}`);
  }, [requests]);

  useEffect(() => {
    if (!sessions) return;
    const ids = new Set(sessions.map((s) => s.id));
    const before = seenSessions.current;
    seenSessions.current = ids;
    if (!before) return; // the first status: these were already connected
    const active = Date.now() - lastInput.current < 2 * 60_000;
    for (const s of sessions) {
      if (before.has(s.id) || !active) continue;
      cmd.notify({ tag: `remote-session-${s.deviceId}`, title: `${s.name} connected`, body: `${scopeLabel(s.scope)} · from ${s.ip}`, sound: null, paneId: null });
    }
  }, [sessions]);
}
