// Settings → Remote Access (docs/13-remote-access.md, "Experience"): one switch,
// then a pairing code right away, the way linked devices work in Signal and
// WhatsApp. Below it: who is connected now and what they're watching, the paired
// devices (access, last seen, unpair), recent activity, and how phones connect
// (the relay, Tailscale or your own URL, docs/38). A device asking to pair is
// answered right here as well.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { renderSVG } from "uqr";
import type { RemoteDevice, RemoteLogEntry, RemoteScope, RemoteStatus, SettingKey } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { PairPrompt, scopeLabel } from "../components/PairPrompt.tsx";
import { Button, Callout, FormActions, FormRow, FormSection, Inline, Prose, QrCode, Segmented, Stack, Switch, Text } from "@cmd/ui";

const STATE_LINE: Record<RemoteStatus["state"], string> = {
  off: "Off.",
  connecting: "Connecting to the relay…",
  online: "Ready. Paired devices can connect.",
  error: "Can't reach the relay. Retrying…",
};

/** The status line, for the relay or a direct access mode (docs/38). */
function stateLine(status: RemoteStatus | null): string {
  const state = status?.state ?? "connecting";
  if (!status || status.access === "relay") return state === "error" && status?.error ? `Can't reach the relay: ${status.error}` : STATE_LINE[state];
  if (state === "error") return status.error ?? "Not reachable yet.";
  if (state === "connecting") return "Getting ready…";
  return status.address ? `Ready on ${new URL(status.address).host}. Paired devices can connect.` : STATE_LINE.online;
}

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
  const access = status?.access ?? "relay";
  // First run: nobody paired yet, so the code is what you came for.
  const pairing = enabled && (showPair || devices.length === 0);

  return (
    <>
      <FormSection>
        <FormRow
          title="Remote access"
          description="Use your terminals and agents from your phone, end-to-end encrypted."
          note={enabled ? stateLine(status) : undefined}
          noteTone={status?.state === "error" ? "danger" : "accent"}
        >
          <Switch checked={enabled} label="Remote access" onChange={(v) => void cmd.call(v ? "remote.enable" : "remote.disable", {})} />
        </FormRow>
      </FormSection>

      {request ? (
        <FormSection title="Pair a Device">
          <Stack pad="xl">
            <PairPrompt request={request} autoFocus={false} />
          </Stack>
        </FormSection>
      ) : pairing ? (
        <FormSection title="Pair a Device">
          <PairCode status={status} onDone={devices.length ? () => setShowPair(false) : undefined} />
        </FormSection>
      ) : null}

      {sessions.length > 0 && (
        <FormSection title="Connected Now">
          {sessions.map((s) => (
            <FormRow key={s.id} title={s.name} description={`${scopeLabel(s.scope)} · since ${new Date(s.since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${s.watching.length ? `watching ${s.watching.length} window${s.watching.length === 1 ? "" : "s"}` : "on its home screen"} · ${s.ip}`}>
              <Button onClick={() => void cmd.call("remote.disconnect", { id: s.deviceId })}>
                Disconnect
              </Button>
            </FormRow>
          ))}
        </FormSection>
      )}

      {devices.length > 0 && (
        <FormSection title="Paired Devices">
          {devices.map((d) => (
            <DeviceRow key={d.id} d={d} />
          ))}
        </FormSection>
      )}
      {devices.length > 0 && enabled && !pairing && (
        <FormActions>
          <Button onClick={() => setShowPair(true)}>
            Pair a Device…
          </Button>
        </FormActions>
      )}

      <Activity key={devices.length + sessions.length} />

      <FormSection title="Connection">
        {row("remote.access")}
        {access === "relay" && row("remote.relay")}
        {access === "relay" && row("remote.client")}
        {access === "url" && row("remote.url")}
        {access === "tailscale" && row("remote.tailscale.port")}
        {access !== "relay" && row("remote.port")}
        {row("remote.deviceExpiryDays")}
      </FormSection>
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
  if (!online)
    return (
      <Stack pad="xl">
        <Text tone="dim">{stateLine(status)}</Text>
      </Stack>
    );
  if (error) return <Callout tone="danger">{/client/.test(error) ? "Set the web client's address under Connection first." : error}</Callout>;
  const left = code ? Math.max(0, Math.round((code.expiresAt - 60_000 - now) / 1000)) : 0;
  return (
    <Stack pad="xl">
      <Inline gap="xl">
        <QrCode svg={svg ?? ""} />
        <Stack gap="md" grow>
          <Prose>
            <ol>
              <li>Point your phone's camera at the code.</li>
              <li>Check that both screens show the same four words.</li>
              <li>Allow it here, with view-only access or control.</li>
            </ol>
          </Prose>
          <Inline gap="md">
            <Button
              disabled={!code}
              onClick={() => code && void navigator.clipboard.writeText(code.url).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
            >
              {copied ? "Copied" : "Copy Link"}
            </Button>
            {onDone && (
              <Button onClick={onDone}>
                Done
              </Button>
            )}
          </Inline>
          <Text size="sm" tone="dim">
            Works once. A new code in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}.
          </Text>
        </Stack>
      </Inline>
    </Stack>
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
    <FormRow title={d.name} description={`${seen} · paired ${day(d.pairedAt)}`}>
      <Segmented value={d.scope} options={["view", "control"]} labels={{ view: "View only", control: "Control" }} onChange={(v) => void cmd.call("remote.setScope", { id: d.id, scope: v as RemoteScope })} />
      <Button onClick={() => void unpair()}>
        Unpair
      </Button>
    </FormRow>
  );
}

/** Recent activity from the audit log, newest first. */
function Activity() {
  const [log, setLog] = useState<RemoteLogEntry[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => void cmd.call("remote.log", { limit: all ? 100 : 8 }).then(setLog, () => setLog(null)), [all]);
  if (!log?.length) return null;
  return (
    <>
      <FormSection title="Recent Activity">
        {log.map((e, i) => (
          <FormRow key={`${e.at}-${i}`} title={`${LOG_TEXT[e.kind] ?? e.kind}${e.device ? ` · ${e.device}` : ""}`} description={e.detail ?? undefined}>
            <Text size="sm" tone="dim">{new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</Text>
          </FormRow>
        ))}
      </FormSection>
      {!all && log.length >= 8 && (
        <FormActions>
          <Button onClick={() => setAll(true)}>
            Show More
          </Button>
        </FormActions>
      )}
    </>
  );
}
