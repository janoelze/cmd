// Settings → Remote Access (docs/13-remote-access.md, "Experience"): one switch,
// then a pairing code right away, the way linked devices work in Signal and
// WhatsApp. Below it: who is connected now and what they're watching, the paired
// devices (access, last seen, unpair), recent activity, and the relay and client
// addresses. A device asking to pair is answered right here as well.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { renderSVG } from "uqr";
import type { RemoteDevice, RemoteLogEntry, RemoteScope, RemoteStatus, SettingKey } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { PairPrompt, scopeLabel } from "../components/PairPrompt.tsx";
import { RowShell, SectionView } from "./SettingsWindow.tsx";
import { Segmented, Switch } from "./controls.tsx";

const STATE_LINE: Record<RemoteStatus["state"], string> = {
  off: "Off.",
  connecting: "Connecting to the relay…",
  online: "Ready. Paired devices can connect.",
  error: "Can't reach the relay. Retrying…",
};

const LOG_TEXT: Record<string, string> = {
  enabled: "Turned on",
  disabled: "Turned off",
  "pair-link": "Pairing code shown",
  paired: "Paired",
  "pair-denied": "Pairing not allowed",
  session: "Connected",
  "session-end": "Disconnected",
  disconnected: "Disconnected from this Mac",
  denied: "Refused a request",
  "handshake-failed": "Refused a connection",
  revoked: "Unpaired",
  scope: "Access changed",
  expired: "Unpaired (unused)",
};

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} days ago`;
}
const day = (t: number) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });

export function Remote({ status, enabled, pair, row }: { status: RemoteStatus | null; enabled: boolean; pair: boolean; row: (k: SettingKey) => ReactNode }) {
  const [showPair, setShowPair] = useState(pair);
  useEffect(() => void (pair && setShowPair(true)), [pair]);
  const devices = status?.devices ?? [];
  const sessions = status?.sessions ?? [];
  const request = status?.requests[0];
  // First run: nobody paired yet, so the code is what you came for.
  const pairing = enabled && (showPair || devices.length === 0);

  return (
    <>
      <SectionView>
        <RowShell
          title="Remote access"
          desc="Use your terminals and agents from your phone or any browser, end-to-end encrypted."
          note={enabled ? (status?.error && status.state === "error" ? `Can't reach the relay: ${status.error}` : STATE_LINE[status?.state ?? "connecting"]) : undefined}
          noteError={status?.state === "error"}
        >
          <Switch value={enabled} label="Remote access" onChange={(v) => void cmd.call(v ? "remote.enable" : "remote.disable", {})} />
        </RowShell>
      </SectionView>

      {request ? (
        <SectionView title="Pair a Device">
          <div className="rm-card">
            <PairPrompt request={request} autoFocus={false} />
          </div>
        </SectionView>
      ) : pairing ? (
        <SectionView title="Pair a Device">
          <PairCode status={status} onDone={devices.length ? () => setShowPair(false) : undefined} />
        </SectionView>
      ) : null}

      {sessions.length > 0 && (
        <SectionView title="Connected Now">
          {sessions.map((s) => (
            <RowShell key={s.id} title={s.name} desc={`${scopeLabel(s.scope)} · since ${new Date(s.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${s.watching.length ? `watching ${s.watching.length} window${s.watching.length === 1 ? "" : "s"}` : "on its home screen"} · ${s.ip}`}>
              <button className="sw-button" onClick={() => void cmd.call("remote.disconnect", { id: s.deviceId })}>
                Disconnect
              </button>
            </RowShell>
          ))}
        </SectionView>
      )}

      {devices.length > 0 && (
        <SectionView title="Paired Devices">
          {devices.map((d) => (
            <DeviceRow key={d.id} d={d} />
          ))}
          {enabled && !pairing && (
            <div className="rm-actions">
              <button className="sw-button" onClick={() => setShowPair(true)}>
                Pair a Device…
              </button>
            </div>
          )}
        </SectionView>
      )}

      <Activity key={devices.length + sessions.length} />

      <SectionView title="Connection">
        {row("remote.relay")}
        {row("remote.client")}
        {row("remote.deviceExpiryDays")}
      </SectionView>
    </>
  );
}

/** A one-time code that renews itself while you look at it (WhatsApp Web style). */
function PairCode({ status, onDone }: { status: RemoteStatus | null; onDone?: () => void }) {
  const [code, setCode] = useState<{ url: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const online = status?.state === "online";

  useEffect(() => {
    if (!online) return setCode(null);
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const next = () =>
      cmd.call("remote.pair", {}).then(
        (c) => {
          if (!live) return;
          setCode(c);
          setError(null);
          timer = setTimeout(next, Math.max(5_000, c.expiresAt - Date.now() - 60_000));
        },
        (err: Error) => live && (setError(err.message), setCode(null)),
      );
    void next();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => ((live = false), clearTimeout(timer), clearInterval(tick));
  }, [online]);

  const svg = useMemo(() => (code ? renderSVG(code.url, { ecc: "L", border: 2, pixelSize: 6 }) : null), [code]);
  if (!online) return <div className="rm-card rm-wait">{STATE_LINE[status?.state ?? "connecting"]}</div>;
  if (error) return <div className="rm-card rm-wait sw-error">{/client/.test(error) ? "Set the web client's address under Connection first." : error}</div>;
  const left = code ? Math.max(0, Math.round((code.expiresAt - 60_000 - now) / 1000)) : 0;
  return (
    <div className="rm-card rm-pair">
      <div className="rm-qr" dangerouslySetInnerHTML={{ __html: svg ?? "" }} />
      <div className="rm-steps">
        <ol>
          <li>Point your phone's camera at the code.</li>
          <li>Check that both screens show the same four words.</li>
          <li>Allow it here, with view-only access or control.</li>
        </ol>
        <div className="rm-pair-foot">
          <button
            className="sw-button"
            disabled={!code}
            onClick={() => code && void navigator.clipboard.writeText(code.url).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
          >
            {copied ? "Copied" : "Copy Link"}
          </button>
          {onDone && (
            <button className="sw-button" onClick={onDone}>
              Done
            </button>
          )}
        </div>
        <div className="rm-dim">Works once. A new code in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}.</div>
      </div>
    </div>
  );
}

function DeviceRow({ d }: { d: RemoteDevice }) {
  const unpair = async () => {
    if (await cmd.confirm({ message: `Unpair “${d.name}”?`, detail: "It disconnects now and needs a new pairing code to come back.", confirm: "Unpair" })) {
      void cmd.call("remote.revoke", { id: d.id });
    }
  };
  const seen = d.connected ? "Connected" : `Last seen ${ago(d.lastSeenAt)}`;
  return (
    <RowShell title={d.name} desc={`${seen} · paired ${day(d.pairedAt)}`}>
      <Segmented value={d.scope} options={["view", "control"]} labels={{ view: "View only", control: "Control" }} onChange={(v) => void cmd.call("remote.setScope", { id: d.id, scope: v as RemoteScope })} />
      <button className="sw-button" onClick={() => void unpair()}>
        Unpair
      </button>
    </RowShell>
  );
}

/** Recent activity from the audit log, newest first. */
function Activity() {
  const [log, setLog] = useState<RemoteLogEntry[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => void cmd.call("remote.log", { limit: all ? 100 : 8 }).then(setLog, () => setLog(null)), [all]);
  if (!log?.length) return null;
  return (
    <SectionView title="Recent Activity">
      {log.map((e, i) => (
        <RowShell key={`${e.at}-${i}`} title={`${LOG_TEXT[e.kind] ?? e.kind}${e.device ? ` · ${e.device}` : ""}`} desc={e.detail ?? undefined}>
          <span className="rm-dim">{new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
        </RowShell>
      ))}
      {!all && log.length >= 8 && (
        <div className="rm-actions">
          <button className="sw-button" onClick={() => setAll(true)}>
            Show More
          </button>
        </div>
      )}
    </SectionView>
  );
}
