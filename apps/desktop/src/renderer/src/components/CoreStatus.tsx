// The sidebar footer: the core's connection and health in one line (status
// light, memory, CPU). Clicking it opens the details (uptime, response time,
// the core and PTY host processes) with Restart Core and the Task Manager.

import { Button } from "@cmd/ui";
import { useEffect, useRef, useState } from "react";
import { cmd } from "../bridge.ts";
import { formatUptime, restartCore, SLOW_MS, useCoreHealth, useRestart, type CoreHealth } from "../coreHealth.ts";
import { formatBytes, usageLabel } from "../model.ts";
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

function summarize(p: Props, h: CoreHealth, restarting: boolean): Summary {
  if (restarting) return { led: "working", text: "Restarting core…", detail: "Starting a new core; terminals keep running." };
  if (!p.connected) {
    if (p.error) return { led: "needs", text: "Core error", detail: p.error };
    return { led: "working", text: "Connecting to core…", detail: "The core isn't reachable; reconnecting." };
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
  const s = summarize(p, health, restart.restarting);
  // Same key while it changes: the numbers update in place, only showing and hiding animate.
  const usage = p.connected && !restart.restarting && !health.unresponsive ? usageLabel(health.core) : null;
  const root = useRef<HTMLDivElement>(null);

  // Close on a click elsewhere or Escape.
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);

  return (
    <div className="core-status" ref={root}>
      {open && <Details summary={s} health={health} connected={p.connected} restart={restart} />}
      <button className={`core-status-button${open ? " open" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`led led-${s.led === "ok" ? "core-ok" : s.led}`} />
        <Slot className="core-status-text" value={{ text: s.text }} />
        <Slot className="core-status-usage" value={usage ? { text: usage, key: "usage" } : undefined} divider />
      </button>
    </div>
  );
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
      ]
    : [];
  return (
    <div className="core-details" role="dialog" aria-label="Core">
      <div className="core-details-head">
        <span className={`led led-${p.summary.led === "ok" ? "core-ok" : p.summary.led}`} />
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
    </div>
  );
}
