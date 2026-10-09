// Settings → Remote Access (docs/13-remote-access.md, "Experience"): one switch,
// then a pairing code right away, the way linked devices work in Signal and
// WhatsApp. Below it: who is connected now and what they're watching, the paired
// devices (access, last seen, unpair), recent activity, and how phones connect:
// one of the core's access modes (remote.modes, docs/38), with the settings that
// mode names. A device asking to pair is answered right here as well. A mode
// with a setup checklist (Tailscale, your own URL) shows it, with "Check Again";
// the code waits until it passes. Nothing here knows the modes by name.

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { renderSVG } from "uqr";
import type { RemoteAccessCheck, RemoteAccessMode, RemoteDevice, RemoteLogEntry, RemoteScope, RemoteStatus, SettingKey, Settings } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { PairPrompt, scopeLabel } from "../components/PairPrompt.tsx";
import { Button, Callout, Checklist, FormActions, FormRow, FormSection, Inline, Prose, QrCode, Segmented, Spinner, Stack, Switch, Text, type StepState } from "@cmd/ui";

/** The status line: the mode's own words while it connects, the core's when it can't. */
function stateLine(status: RemoteStatus | null, mode: RemoteAccessMode | undefined): string {
  const state = status?.state ?? "connecting";
  if (state === "off") return "Off.";
  if (state === "connecting") return mode?.connecting ?? "Connecting…";
  if (state === "error") return status?.error ? sentence(status.error) : "Can't connect. Retrying…";
  return status?.address ? `Ready on ${new URL(status.address).host}. Paired devices can connect.` : "Ready. Paired devices can connect.";
}

/** "lost the relay; reconnecting" → "Lost the relay; reconnecting." */
const sentence = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}${/[.…?!]$/.test(s) ? "" : "."}`;

/** The core's access modes (remote.modes); empty from a core without them, null until they come. */
export function useAccessModes(): RemoteAccessMode[] | null {
  const [modes, setModes] = useState<RemoteAccessMode[] | null>(null);
  useEffect(() => void cmd.call("remote.modes", {}).then(setModes, () => setModes([])), []);
  return modes;
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

const STEP_STATE: Record<RemoteAccessCheck["state"], StepState> = { ok: "done", todo: "todo", error: "failed" };

export function Remote({ status, settings, pair, row }: { status: RemoteStatus | null; settings: Settings; pair: boolean; row: (k: SettingKey) => ReactNode }) {
  const enabled = settings["remote.enabled"];
  const [showPair, setShowPair] = useState(pair);
  useEffect(() => void (pair && setShowPair(true)), [pair]);
  const devices = status?.devices ?? [];
  const sessions = status?.sessions ?? [];
  const request = status?.requests[0];
  const access = settings["remote.access"];
  const modes = useAccessModes();
  const mode = modes?.find((m) => m.id === access);
  // First run: nobody paired yet, so the code is what you came for.
  const pairing = enabled && (showPair || devices.length === 0);
  const guided = enabled && !!mode?.setup;
  // The checks look again when the mode's settings change.
  const config = [access, ...(mode?.settings ?? []).map((k) => String(settings[k]))].join(" ");
  const setup = useChecks(guided ? access : null, status?.state, config);
  // A mode with a checklist pairs once it's set up: every check passes, or it's online already.
  const ready = !guided || status?.state === "online" || (!!setup.checks?.length && setup.checks.every((c) => c.state === "ok"));
  const checklist = guided && <Setup title={mode.title} {...setup} />;
  const line = stateLine(status, mode);

  return (
    <>
      <FormSection>
        <FormRow
          title="Remote access"
          description="Use your terminals and agents from your phone, end-to-end encrypted."
          note={enabled ? line : undefined}
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
          {ready ? (
            <PairCode status={status} line={line} onDone={devices.length ? () => setShowPair(false) : undefined} />
          ) : (
            <SetupWait />
          )}
        </FormSection>
      ) : null}

      {!ready && checklist}

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

      {ready && checklist}

      <FormSection title="Connection">
        {row("remote.access")}
        {mode?.settings.map((k) => <Fragment key={k}>{row(k)}</Fragment>)}
        {row("remote.deviceExpiryDays")}
      </FormSection>
    </>
  );
}

export type ChecksState = { checks: RemoteAccessCheck[] | null; error: string | null; busy: boolean; again: () => void };

/**
 * The access mode's checklist, fetched when the page shows, the mode or its
 * settings change, or the status moves on. Checks run the tailscale CLI and probe
 * HTTPS, so changes are debounced and an answer for an older ask is dropped.
 */
function useChecks(access: string | null, state: RemoteStatus["state"] | undefined, config: string): ChecksState {
  const [checks, setChecks] = useState<RemoteAccessCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = useRef(0);
  const run = (method: "remote.checks" | "remote.setup", mode: string) => {
    const n = ++ask.current;
    setBusy(true);
    const call = method === "remote.setup" ? cmd.call("remote.setup", {}) : cmd.call("remote.checks", { access: mode });
    void call.then(
      (c) => n === ask.current && (setChecks(c), setError(null), setBusy(false)),
      (err: Error) => n === ask.current && (setError(err.message), setBusy(false)),
    );
  };
  useEffect(() => setChecks(null), [access]);
  // Back from the browser (an admin console, a download): look again.
  useEffect(() => {
    if (!access) return;
    const look = () => run("remote.checks", access);
    window.addEventListener("focus", look);
    return () => window.removeEventListener("focus", look);
  }, [access]);
  useEffect(() => {
    if (!access) return void ++ask.current;
    const timer = setTimeout(() => run("remote.checks", access), 400);
    return () => clearTimeout(timer);
  }, [access, state, config]);
  return { checks, error, busy, again: () => access && run("remote.setup", access) };
}

/** Where the pairing code goes while a mode isn't set up yet. */
export function SetupWait() {
  return <div className="rm-card rm-wait">Finish the setup below to get a pairing code.</div>;
}

/** The setup checklist of an access mode (docs/38, "Experience"), titled after it; stories in Remote.story.tsx. */
export function Setup({ title, checks, error, busy, again }: { title: string } & ChecksState) {
  const current = checks?.findIndex((c) => c.state !== "ok") ?? -1;
  /** On the step that needs you: what checking again does there, in the check's words. */
  const againButton = (c: RemoteAccessCheck) => (
    <Button variant={c.link ? "ghost" : "default"} busy={busy} disabled={busy} onClick={again}>
      {c.action ?? (c.state === "error" ? "Try Again" : "Check Again")}
    </Button>
  );
  return (
    <FormSection title={`Set Up ${title}`} plain>
      {error && !checks ? (
        <>
          <div className="rm-card">
            <Callout tone="danger">Couldn't check the setup: {error}</Callout>
          </div>
          <div className="rm-actions">
            <Button busy={busy} disabled={busy} onClick={again}>
              Check Again
            </Button>
          </div>
        </>
      ) : !checks ? (
        <div className="rm-card rm-wait rm-checking">
          <Spinner /> Checking…
        </div>
      ) : (
        <Checklist
          steps={checks.map((c, i) => ({
            title: c.title,
            state: STEP_STATE[c.state],
            detail: c.detail,
            action: (c.link || i === current) && (
              <>
                {c.link && <Button onClick={() => cmd.openPath(c.link!)}>{c.linkLabel ?? "Open"}</Button>}
                {i === current && againButton(c)}
              </>
            ),
          }))}
        />
      )}
    </FormSection>
  );
}

/** A one-time code that renews itself while you look at it (WhatsApp Web style). */
function PairCode({ status, line, onDone }: { status: RemoteStatus | null; line: string; onDone?: () => void }) {
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
        <Text tone="dim">{line}</Text>
      </Stack>
    );
  if (error) return <Callout tone="danger">{error}</Callout>;
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
