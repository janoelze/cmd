// Left end of the footer: the core's connection and health in one line (status
// light, memory, CPU). Clicking it opens the details (uptime, response time,
// the core and PTY host processes) with Restart Core and the Task Manager.

import { Button, Popover, StatusDot } from "@cmd/ui";
import { useRef, useState } from "react";
import type { StartupStatus } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { formatUptime, restartCore, SLOW_MS, useCoreHealth, useRestart, type CoreHealth } from "../coreHealth.ts";
import { formatBytes, usageLabel } from "../model.ts";
import { useStoreValue } from "../store.ts";
import { Slot } from "./Slot.tsx";

interface Props {
  connected: boolean;
  error?: string;
}

type Led = "ok" | "working" | "needs";

interface Summary {
  led: Led;
  /** The footer's label; its usage follows when the core answers. */
  text: string;
  /** A sentence for the details. */
  detail: string;
}

function summarize(p: Props, h: CoreHealth, restarting: boolean, startup: StartupStatus | null): Summary {
  if (restarting) return { led: "working", text: "Restarting core…", detail: "Starting a new core; terminals keep running." };
  if (!p.connected) {
    if (p.error) return { led: "needs", text: "Core error", detail: p.error };
    return { led: "working", text: "Connecting to core…", detail: "The core isn't reachable; reconnecting." };
  }
  // Connected, still starting up behind the socket: say what it does (the first launch of a version rebuilds its views).
  if (startup?.phase === "starting") {
    const doing = startup.tasks[0]?.label;
    return { led: "working", text: doing ? `Starting · ${doing[0]!.toLowerCase()}${doing.slice(1)}` : "Starting…", detail: doing ? `${doing}. Terminals work meanwhile.` : "Finishing startup. Terminals work meanwhile." };
  }
  if (h.unresponsive) return { led: "needs", text: "Core not responding", detail: "The core is connected but didn't answer in time." };
  if (h.outdated) return { led: "needs", text: "Core outdated · restart", detail: "Started from an older version than this app. Restart it to pick up the changes." };
  if (h.latency !== null && h.latency > SLOW_MS) return { led: "needs", text: `Core slow · ${h.latency} ms`, detail: `The core takes ${h.latency} ms to answer.` };
  return { led: "ok", text: "Core", detail: "Connected and healthy." };
}

export function CoreStatus(p: Props) {
  const [open, setOpen] = useState(false);
  const health = useCoreHealth(p.connected, open);
  const restart = useRestart();
  // The event is the fresh one; core.info's copy covers a window that connected after the last change.
  const startup = useStoreValue((st) => st.startup) ?? health.info?.startup ?? null;
  const s = summarize(p, health, restart.restarting, startup);
  // Same key while it changes: the numbers update in place, only showing and hiding animate.
  const usage = p.connected && !restart.restarting && !health.unresponsive ? usageLabel(health.core) : null;
  const button = useRef<HTMLButtonElement>(null);

  return (
    <div className="core-status">
      <Popover anchor={button} open={open} onClose={() => setOpen(false)} placement="above" width={Math.max(280, button.current?.offsetWidth ?? 0)} className="core-details" label="Core">
        <Details summary={s} health={health} connected={p.connected} restart={restart} />
      </Popover>
      <button
        ref={button}
        className={`core-status-button${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        // A steady name; the state and the live numbers are the description.
        aria-label="Core"
        aria-description={[s.text, usage].filter(Boolean).join(", ")}
      >
        <StatusDot state={s.led === "ok" ? "success" : s.led} />
        <Slot className="core-status-text" value={{ text: s.text }} />
        <Slot className="core-status-usage" value={usage ? { text: usage, key: "usage" } : undefined} divider />
      </button>
    </div>
  );
}

/** The longest time the core's thread was blocked since it started, and by what: a row only when there was one. */
function stallRow(stalls: { at: number; ms: number; in: string }[] | undefined): [string, string, string?][] {
  if (!stalls?.length) return [];
  const worst = stalls.reduce((a, b) => (b.ms > a.ms ? b : a));
  return [["Stalls", `${stalls.length} · longest ${worst.ms} ms`, `in ${worst.in}`]];
}

function Details(p: { summary: Summary; health: CoreHealth; connected: boolean; restart: { restarting: boolean; error: string | null } }) {
  const { info, core, ptyHost, latency } = p.health;
  const proc = (x: { memory: number; cpu: number; pid: number } | null) => (x ? `${formatBytes(x.memory)} · ${x.cpu.toFixed(1)}%` : "—");
  const rows: [string, string, string?][] = info
    ? [
        ["Uptime", formatUptime(Date.now() - info.startedAt)],
        ["Response", latency === null ? "—" : `${latency} ms`],
        ["Core", proc(core), core ? `pid ${core.pid}` : `pid ${info.pid}`],
        ["PTY host", info.ptyHost ? proc(ptyHost) : "not running", info.ptyHost ? `pid ${info.ptyHost.pid}` : undefined],
        ["Terminals", String(info.panes)],
        ["Clients", String(info.connections)],
        ["Build", info.build.slice(0, 8) || "—"],
        ...stallRow(info.stalls),
      ]
    : [];
  return (
    <>
      <div className="core-details-head">
        <StatusDot state={p.summary.led === "ok" ? "success" : p.summary.led} />
        <span>{p.summary.detail}</span>
      </div>
      {p.restart.error && <div className="core-details-error">{p.restart.error}</div>}
      {rows.length > 0 && (
        <dl className="core-details-rows">
          {rows.map(([k, v, sub]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
              <dd className="core-details-sub">{sub}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="core-details-actions">
        <Button variant={p.health.outdated || p.health.unresponsive || !p.connected ? "primary" : "default"} disabled={p.restart.restarting} onClick={() => void restartCore()}>
          {p.restart.restarting ? "Restarting…" : "Restart Core"}
        </Button>
        <Button onClick={() => cmd.openTaskManager()}>
          Task Manager
        </Button>
      </div>
    </>
  );
}
