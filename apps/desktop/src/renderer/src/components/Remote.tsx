// Remote access in the main window (docs/13-remote-access.md, "Experience"):
// the sheet that lets a device in (approval only ever happens here, in Settings
// or in `cmd remote pair`), the status bar indicator (its state at a glance; who
// is in, with what access, watching which windows; disconnect in one click),
// and the notifications that go with them.

import { Badge, Button, IconButton, Inline, ListRow, LiveBadge, Popover, Separator, Spacer, Stack, Text, useTooltip } from "@cmd/ui";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { RemoteStatus } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { getState, useStoreValue } from "../store.ts";
import { ICON, Symbol } from "./Symbol.tsx";
import { scopeLabel } from "./PairPrompt.tsx";

export { PairSheet } from "./PairPrompt.tsx";

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
    <LiveBadge icon="iphone" note={typed && !compact ? `typed from ${typed}` : undefined} tip={typed ? `${typed} typed here` : `Watched from ${watchers.join(", ")}`} />
  );
}

// ── status bar indicator ───────────────────────────────

/** Any access mode's state; its own words are in Settings → Remote Access. */
const STATE_TEXT = { off: "Off", connecting: "Connecting…", online: "Ready", error: "Can't connect" } as const;

/**
 * In the status bar while remote access is on. Its colour says the state at a
 * glance: dim when ready, accent while a device is connected, pulsing while one
 * waits for approval, warning when devices can't reach this Mac. Its tooltip says
 * who is in and what they watch; the popover (a click) also offers Disconnect.
 */
export function RemoteIndicator() {
  const status = useStoreValue((s) => s.remote);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const tipRef = useTooltip(() => status && <RemoteTip status={status} />);
  if (!status || (!status.enabled && !status.sessions.length)) return null;
  const names = [...new Set(status.sessions.map((s) => s.name))];
  const asking = status.requests.length > 0;
  const tone = asking || names.length ? "accent" : status.state === "error" ? "needs" : undefined;
  const tip = status.requests.length
    ? `${status.requests[0]!.name} is waiting for approval`
    : names.length
      ? `Connected: ${names.join(", ")}`
      : `Remote access: ${STATE_TEXT[status.state]}`;
  return (
    <>
      <IconButton
        ref={(el) => ((button.current = el), tipRef(el))}
        className="remote-indicator"
        tone={tone}
        pulse={asking}
        icon={names.length ? "iphone.radiowaves.left.and.right" : "iphone"}
        label={tip}
        // The rich tooltip (tipRef) stands in for the plain one.
        data-tip={undefined}
        pressed={open}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open && <RemotePopover anchor={button} status={status} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The indicator's tooltip: the state, who waits, who is in and what they watch. */
function RemoteTip({ status }: { status: RemoteStatus }) {
  const { sessions, requests } = status;
  const paired = status.devices.length;
  return (
    <div>
      <div className="tip-head">Remote Access · {sessions.length && status.state === "online" ? "Connected" : STATE_TEXT[status.state]}</div>
      {status.state === "error" && status.error && <div className="tip-dim">{status.error}</div>}
      {requests.map((r) => (
        <Inline key={r.requestId} gap="md" align="start">
          <Symbol name="iphone" size={ICON.small} />
          <span>
            <b>{r.name}</b> is waiting for you to allow it
          </span>
        </Inline>
      ))}
      {sessions.map((s) => (
        <Inline key={s.id} gap="md" align="start">
          <Symbol name="iphone.radiowaves.left.and.right" size={ICON.small} />
          <span>
            <b>{s.name}</b> <Badge tone={s.scope === "control" ? "accent" : "neutral"}>{scopeLabel(s.scope)}</Badge>
            <div className="tip-dim">
              Since {clock(s.since)} · {s.watching.length ? `watching ${s.watching.map(windowTitle).join(", ")}` : "on its home screen"}
            </div>
          </span>
        </Inline>
      ))}
      {!sessions.length && !requests.length && <div className="tip-dim">{paired ? `No device connected. ${paired} paired.` : "No devices paired yet."}</div>}
      <div className="tip-foot">Click for options</div>
    </div>
  );
}

function RemotePopover({ anchor, status, onClose }: { anchor: RefObject<HTMLElement | null>; status: RemoteStatus; onClose: () => void }) {
  const { sessions } = status;
  const act = (fn: () => unknown) => () => (void fn(), onClose());
  const paired = status.devices.length;
  return (
    // Opens upward from the status bar, its right edge at the button's.
    <Popover anchor={anchor} open onClose={onClose} placement="above" align="end" width={420} className="remote-popover" label="Remote Access">
      <Stack gap="sm" pad="sm">
        <Stack gap="2xs" pad="xs">
          <Text size="sm" tone="dim" strong>
            Remote Access · {sessions.length && status.state === "online" ? "Connected" : STATE_TEXT[status.state]}
          </Text>
          {status.state === "error" && status.error ? (
            <Text size="sm" tone="dim" truncate>
              {status.error}
            </Text>
          ) : null}
        </Stack>
        <div>
          {status.requests.map((r) => (
            <ListRow key={r.requestId} icon="iphone" title={<span><b>{r.name}</b> is waiting for you to allow it</span>} />
          ))}
          {sessions.map((s) => (
            <ListRow
              key={s.id}
              icon="iphone.radiowaves.left.and.right"
              title={
                <span>
                  {s.name} <Badge tone={s.scope === "control" ? "accent" : "neutral"}>{scopeLabel(s.scope)}</Badge>
                </span>
              }
              detail={`Since ${clock(s.since)} · ${s.watching.length ? `watching ${s.watching.map(windowTitle).join(", ")}` : "on its home screen"}`}
              end={<Button onClick={act(() => cmd.call("remote.disconnect", { id: s.deviceId }))}>Disconnect</Button>}
            />
          ))}
          {!sessions.length && !status.requests.length && <ListRow title={<Text tone="dim">{paired ? `No device connected. ${paired} paired.` : "No devices paired yet."}</Text>} />}
        </div>
        <Separator />
        <Inline gap="sm">
          {sessions.length > 0 && <Button onClick={act(() => cmd.call("remote.disconnect", {}))}>Disconnect All</Button>}
          <Button onClick={act(() => cmd.call("remote.disable", {}))}>Turn Off</Button>
          <Spacer />
          <Button onClick={act(() => cmd.openSettings("remote/pair"))}>Pair a Device…</Button>
          <Button onClick={act(() => cmd.openSettings("remote"))}>Settings…</Button>
        </Inline>
      </Stack>
    </Popover>
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
