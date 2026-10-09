// Settings → Updates & About: versions and updates, the core's health, crash reports and
// where cmd keeps its files and logs, plus what to do when something is off
// (restart the core, open its log, copy everything for a bug report). core.info
// is polled while the page is open, faster while an update is checked or downloaded.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CoreInfo } from "@cmd/protocol";
import type { AppInfo } from "../../../preload/index.ts";
import { Badge, Button, Callout, FormActions, FormRow, FormSection, Progress, Text } from "@cmd/ui";
import { cmd } from "../bridge.ts";

const POLL_MS = 2000;
const POLL_BUSY_MS = 400;
const REVEAL = navigator.platform.startsWith("Mac") ? "Show in Finder" : "Show in Explorer";

const MODE_LABEL = { auto: "Installs automatically", notify: "Notifies you", off: "Not checking" } as const;

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const ago = (t: number) => `${duration(Date.now() - t)} ago`;

function updateLine(a: AppInfo): string {
  const u = a.updates;
  if (a.dev) return "Development build: doesn't update itself. Install a release for updates.";
  if (u.ready) return `cmd ${u.ready} is downloaded and installs when you quit.`;
  if (u.downloading)
    return u.downloading.percent < 100
      ? `Downloading cmd ${u.downloading.version}… ${Math.floor(u.downloading.percent)}%`
      : `Preparing cmd ${u.downloading.version}…`;
  if (u.checking) return "Checking for updates…";
  if (u.available) return `cmd ${u.available} is available.`;
  if (u.lastError) return `Last check failed: ${u.lastError}`;
  return `${MODE_LABEL[u.mode]}. ${u.lastCheck ? `Last checked ${ago(u.lastCheck)}.` : "Not checked yet."}`;
}

function debugText(a: AppInfo | null, c: CoreInfo | null): string {
  const lines = [
    `cmd ${a?.version ?? "?"}${a?.dev ? " (development)" : ""}`,
    `Electron ${a?.electron ?? "?"}, Chromium ${a?.chrome ?? "?"}`,
    `App build ${a?.build ?? "?"}`,
  ];
  if (a) lines.push(`Updates: ${updateLine(a)}`);
  if (c)
    lines.push(
      `Core pid ${c.pid}, build ${c.build}${a && c.build !== a.build ? " (outdated)" : ""}, Node ${c.node}`,
      `Core up ${duration(Date.now() - c.startedAt)}, ${mb(c.rssBytes)} memory, ${c.cpuSeconds.toFixed(1)} s CPU, ${c.panes} terminals, ${c.connections} connections`,
      `Core runs from ${c.root}`,
      c.ptyHost ? `PTY host pid ${c.ptyHost.pid}, up ${duration(Date.now() - c.ptyHost.startedAt)}, runs from ${c.ptyHost.root}` : "PTY host: none (terminals run in the core)",
      `Socket ${c.socket}`,
    );
  else lines.push("Core: not connected");
  if (a) lines.push(`State ${a.home}`, `Logs ${a.logs}`);
  return lines.join("\n");
}

/** A value to read and select, e.g. a path or a hash. */
const Value = (p: { children: ReactNode }) => (
  <Text size="sm" tone="dim" select>
    {p.children}
  </Text>
);

function PathRow(p: { title: string; path: string | null | undefined }) {
  if (!p.path) return null;
  return (
    <FormRow title={p.title} description={
        <Text size="xs" mono select>
          {p.path}
        </Text>
      }>
      <Button onClick={() => cmd.revealPath(p.path!)}>
        {REVEAL}
      </Button>
    </FormRow>
  );
}

const updateBusy = (a: AppInfo | null) => !!a && (a.updates.checking || !!a.updates.downloading);

/** Settings → Updates & About's "Latest version" button: what the next step is. */
function UpdateButton(p: { app: AppInfo | null; poll: () => void }) {
  const u = p.app?.updates;
  const check = () => (cmd.checkForUpdates(), setTimeout(p.poll, 100));
  if (u?.ready)
    return (
      <Button onClick={() => cmd.installUpdate()}>
        Restart to Update
      </Button>
    );
  if (u?.downloading) return <Progress value={u.downloading.percent / 100} label="Downloading" />;
  return (
    <Button disabled={!p.app || p.app.dev || u?.checking} onClick={check}>
      {u?.checking ? "Checking…" : u?.available ? "Download" : "Check Now"}
    </Button>
  );
}

function crashLine(a: AppInfo): string {
  const c = a.crashes;
  const waiting = c.pending ? ` ${c.pending} waiting to be sent.` : "";
  return c.sending ? `Sent when cmd crashes or hits an internal error.${waiting}` : `${c.reason} Reports are kept in the logs folder.`;
}

export function About(p: { updates: ReactNode; crashReports: ReactNode; usageStats: ReactNode }) {
  const [app, setApp] = useState<AppInfo | null>(null);
  const [core, setCore] = useState<CoreInfo | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const poll = useRef<() => void>(() => {});

  useEffect(() => {
    let live = true;
    let inflight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (inflight) return;
      inflight = true;
      clearTimeout(timer);
      // core.info waits for a connection; a core that is down shows as such meanwhile.
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), 1500));
      const [a, c] = await Promise.all([cmd.appInfo(), Promise.race([cmd.call("core.info", {}).catch(() => null), timeout])]);
      inflight = false;
      if (!live) return;
      setApp(a), setCore(c);
      timer = setTimeout(tick, updateBusy(a) ? POLL_BUSY_MS : POLL_MS);
    };
    poll.current = () => void tick();
    void tick();
    return () => ((live = false), clearTimeout(timer));
  }, []);

  // Terminals keep running in the PTY host (or come back, see the core's restore.ts): nothing to confirm.
  const restart = async () => {
    setError(null);
    setRestarting(true);
    try {
      await cmd.restartCore();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRestarting(false);
    }
  };

  const copy = () => {
    void navigator.clipboard.writeText(debugText(app, core)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const outdated = !!app && !!core && core.build !== app.build;

  return (
    <>
      {error && (
        <Callout tone="danger">{error}</Callout>
      )}
      <FormSection title="cmd">
          <FormRow title="Version" description={app && `Electron ${app.electron}, Chromium ${app.chrome}`}>
            <Value>{app?.version ?? "…"}</Value>
            {app?.dev && <Badge>development</Badge>}
          </FormRow>
          {p.updates}
          <FormRow title="Latest version" description={app && updateLine(app)}>
            <UpdateButton app={app} poll={() => poll.current()} />
          </FormRow>
      </FormSection>

      <FormSection title="Core">
          <FormRow
            title="Status"
            description={
              core
                ? outdated
                  ? "Started from an older version than this app. Restart it to pick up the changes."
                  : "Owns terminals, agents and settings, and keeps running when the app quits."
                : restarting
                  ? "Restarting…"
                  : "Not connected. If this lasts, check the log."
            }
          >
            {core ? <Value>pid {core.pid}</Value> : <Text tone="dim">offline</Text>}
            {outdated && <Badge tone="accent">outdated</Badge>}
          </FormRow>
          {core && (
            <>
              <FormRow title="Uptime" description={`Started ${new Date(core.startedAt).toLocaleString()}`}>
                <Value>{duration(Date.now() - core.startedAt)}</Value>
              </FormRow>
              <FormRow title="Memory" description={`${mb(core.heapBytes)} JavaScript heap`}>
                <Value>{mb(core.rssBytes)}</Value>
              </FormRow>
              <FormRow title="CPU time">
                <Value>{core.cpuSeconds.toFixed(1)} s</Value>
              </FormRow>
              <FormRow title="Terminals" description={`${core.connections} connection${core.connections === 1 ? "" : "s"} (app windows, CLI)`}>
                <Value>{core.panes}</Value>
              </FormRow>
              <FormRow title="Build" description={outdated ? `This app ships ${app!.build}.` : `Node ${core.node}`}>
                <Value>{core.build || "unknown"}</Value>
              </FormRow>
            </>
          )}
      </FormSection>
      <FormActions>
        {app && (
          <Button onClick={() => cmd.openPath(app.coreLog)}>
            Open Log
          </Button>
        )}
        <Button disabled={restarting} onClick={() => void restart()}>
          {restarting ? "Restarting…" : "Restart Core…"}
        </Button>
      </FormActions>

      <FormSection title="Diagnostics">
          {p.crashReports}
          <FormRow title="Crash reports" description={app && crashLine(app)}>
            <Button disabled={!app} onClick={() => cmd.revealPath(app!.crashes.folder)}>
              {REVEAL}
            </Button>
          </FormRow>
          {p.usageStats}
      </FormSection>

      <FormSection title="Files">
          <PathRow title="State folder" path={app?.home} />
          <PathRow title="Settings" path={core?.settingsPath} />
          <PathRow title="Logs" path={app?.logs} />
          <PathRow title="Core log" path={app?.coreLog} />
          <PathRow title="Update log" path={app && !app.dev ? app.updateLog : null} />
          <PathRow title="Core runs from" path={core?.root} />
          <PathRow title="Socket" path={core?.socket} />
      </FormSection>
      <FormActions>
        <Button onClick={copy}>
          {copied ? "Copied" : "Copy Debug Info"}
        </Button>
      </FormActions>
    </>
  );
}
