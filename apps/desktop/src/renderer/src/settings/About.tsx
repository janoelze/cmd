// Settings → About: versions, the core's health and where cmd keeps its files,
// plus what to do when something is off (restart the core, open its log, copy
// everything for a bug report). core.info is polled while the page is open.

import { useEffect, useState, type ReactNode } from "react";
import type { CoreInfo } from "@cmd/protocol";
import type { AppInfo } from "../../../preload/index.ts";
import { Symbol } from "../components/Symbol.tsx";
import { cmd } from "../bridge.ts";

const POLL_MS = 2000;

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
      `Socket ${c.socket}`,
    );
  else lines.push("Core: not connected");
  if (a) lines.push(`State ${a.home}`);
  return lines.join("\n");
}

function Row(p: { title: string; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="sw-row">
      <div className="sw-row-text">
        <div className="sw-row-title">{p.title}</div>
        {p.desc && <div className="sw-row-desc">{p.desc}</div>}
      </div>
      <div className="sw-row-control">{p.children}</div>
    </div>
  );
}

/** A value to read and select, e.g. a path or a hash. */
const Value = (p: { children: ReactNode }) => <span className="sw-value">{p.children}</span>;

function PathRow(p: { title: string; path: string | null | undefined }) {
  if (!p.path) return null;
  return (
    <Row title={p.title} desc={<span className="sw-path">{p.path}</span>}>
      <button className="sw-button" onClick={() => cmd.revealPath(p.path!)}>
        Show in Finder
      </button>
    </Row>
  );
}

export function About() {
  const [app, setApp] = useState<AppInfo | null>(null);
  const [core, setCore] = useState<CoreInfo | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    let inflight = false;
    const tick = async () => {
      if (inflight) return;
      inflight = true;
      // core.info waits for a connection; a core that is down shows as such meanwhile.
      const timeout = new Promise<null>((r) => setTimeout(() => r(null), 1500));
      const [a, c] = await Promise.all([cmd.appInfo(), Promise.race([cmd.call("core.info", {}).catch(() => null), timeout])]);
      inflight = false;
      if (live) (setApp(a), setCore(c));
    };
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => ((live = false), clearInterval(t));
  }, []);

  const restart = async () => {
    const n = core?.panes ?? 0;
    const ok = await cmd.confirm({
      message: "Restart the core?",
      detail: `This closes ${n} open terminal${n === 1 ? "" : "s"}. Claude and Codex sessions can be resumed afterwards.`,
      confirm: "Restart Core",
    });
    if (!ok) return;
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
        <div className="sw-error">
          <Symbol name="exclamationmark.triangle.fill" size={11} />
          {error}
        </div>
      )}
      <section>
        <h2 className="sw-section-title">cmd</h2>
        <div className="sw-list">
          <Row title="Version" desc={app && `Electron ${app.electron}, Chromium ${app.chrome}`}>
            <Value>{app?.version ?? "…"}</Value>
            {app?.dev && <span className="sw-tag">development</span>}
          </Row>
          <Row title="Updates" desc={app && updateLine(app)}>
            <button className="sw-button" disabled={!app || app.dev} onClick={() => cmd.checkForUpdates()}>
              Check for Updates…
            </button>
          </Row>
        </div>
      </section>

      <section>
        <h2 className="sw-section-title">Core</h2>
        <div className="sw-list">
          <Row
            title="Status"
            desc={
              core
                ? outdated
                  ? "Started from an older version than this app. Restart it to pick up the changes."
                  : "Owns terminals, agents and settings, and keeps running when the app quits."
                : restarting
                  ? "Restarting…"
                  : "Not connected. If this lasts, check the log."
            }
          >
            {core ? <Value>pid {core.pid}</Value> : <span className="sw-none">offline</span>}
            {outdated && <span className="sw-tag accent">outdated</span>}
          </Row>
          {core && (
            <>
              <Row title="Uptime" desc={`Started ${new Date(core.startedAt).toLocaleString()}`}>
                <Value>{duration(Date.now() - core.startedAt)}</Value>
              </Row>
              <Row title="Memory" desc={`${mb(core.heapBytes)} JavaScript heap; terminals' own processes not included.`}>
                <Value>{mb(core.rssBytes)}</Value>
              </Row>
              <Row title="CPU time">
                <Value>{core.cpuSeconds.toFixed(1)} s</Value>
              </Row>
              <Row title="Terminals" desc={`${core.connections} connection${core.connections === 1 ? "" : "s"} (app windows, CLI)`}>
                <Value>{core.panes}</Value>
              </Row>
              <Row title="Build" desc={outdated ? `This app ships ${app!.build}.` : `Node ${core.node}`}>
                <Value>{core.build || "unknown"}</Value>
              </Row>
            </>
          )}
        </div>
        <div className="sw-page-foot">
          {app && (
            <button className="sw-button" onClick={() => cmd.openPath(app.coreLog)}>
              Open Log
            </button>
          )}
          <button className="sw-button" disabled={restarting} onClick={() => void restart()}>
            {restarting ? "Restarting…" : "Restart Core…"}
          </button>
        </div>
      </section>

      <section>
        <h2 className="sw-section-title">Files</h2>
        <div className="sw-list">
          <PathRow title="State folder" path={app?.home} />
          <PathRow title="Settings" path={core?.settingsPath} />
          <PathRow title="Core log" path={app?.coreLog} />
          <PathRow title="Update log" path={app && !app.dev ? app.updateLog : null} />
          <PathRow title="Core runs from" path={core?.root} />
          <PathRow title="Socket" path={core?.socket} />
        </div>
        <div className="sw-page-foot">
          <button className="sw-button" onClick={copy}>
            {copied ? "Copied" : "Copy Debug Info"}
          </button>
        </div>
      </section>
    </>
  );
}
