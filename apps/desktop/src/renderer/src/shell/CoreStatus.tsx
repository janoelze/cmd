// Left end of the footer: the core's connection and health in one line (status
// light, memory, CPU). Clicking it opens the details (uptime, what the core and
// PTY host use, a recent stall) with Restart Core and the Task Manager, which
// has the rest (pids, terminals); About has the debug info.

import { Button, Inline, KeyValue, Popover, Stack, StatusDot, Text } from "@cmd/ui";
import { useRef, useState } from "react";
import { runningStep, stepLine, type BootReport, type Stall, type StartupStatus } from "@cmd/protocol";
import { useCoreBoot } from "./BootSheet.tsx";
import { cmd } from "../lib/bridge.ts";
import { formatUptime, restartCore, SLOW_MS, useCoreHealth, useRestart, type CoreHealth } from "./coreHealth.ts";
import { formatBytes, usageLabel } from "../lib/model.ts";
import { useStoreValue } from "../lib/store.ts";
import { Slot } from "../components/Slot.tsx";

interface Props {
  connected: boolean;
  error?: string;
}

type Led = "ok" | "working" | "needs";

interface Summary {
  led: Led;
  /** The footer's label; its usage follows when the core answers. */
  text: string;
  /** Which state the label shows, when its text changes within one (a step's count): it updates in place, no swap. */
  key?: string;
  /** A sentence for the details. */
  detail: string;
}

function summarize(p: Props, h: CoreHealth, restarting: boolean, startup: StartupStatus | null, boot: BootReport | null): Summary {
  if (restarting) return { led: "working", text: "Restarting core…", detail: "Starting a new core; terminals keep running." };
  if (!p.connected) {
    if (p.error) return { led: "needs", text: "Core error", detail: p.error };
    // Busy before it answers (the first launch of a version updating data, docs/50): say what it does.
    const step = runningStep(boot);
    if (step) return { led: "working", text: `${stepLine(step)}…`, key: `boot:${step.id}`, detail: "Getting your records ready." };
    return { led: "working", text: "Connecting to core…", detail: "The core isn't reachable; reconnecting." };
  }
  // Connected, still starting up behind the socket: say what it does (the first launch of a version rebuilds its views).
  if (startup?.phase === "starting") {
    const t = startup.tasks[0];
    const doing = `${t?.label ?? "Starting"}${t?.total ? ` · ${Math.min(100, Math.floor(((t.done ?? 0) / t.total) * 100))}%` : ""}…`;
    return { led: "working", text: doing, key: `startup:${t?.id ?? ""}`, detail: `${doing} Terminals work meanwhile.` };
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
  const boot = useCoreBoot().report;
  const s = summarize(p, health, restart.restarting, startup, boot);
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
        <Slot className="core-status-text" value={{ text: s.text, key: s.key }} />
        <Slot className="core-status-usage" value={usage ? { text: usage, key: "usage" } : undefined} divider />
      </button>
    </div>
  );
}

/** Above this, a process's CPU shows beside its memory; below, it is noise. */
const BUSY_CPU = 5;
/** A stall this long, this recently, gets a line; older or shorter ones stay in core.info. */
const STALL_MS = 1000;
const STALL_RECENT_MS = 5 * 60_000;

/** The longest recent block of the core's thread worth mentioning, if any. */
function recentStall(stalls: Stall[] | undefined): Stall | null {
  const recent = (stalls ?? []).filter((s) => s.ms >= STALL_MS && Date.now() - s.at < STALL_RECENT_MS);
  return recent.length ? recent.reduce((a, b) => (b.ms > a.ms ? b : a)) : null;
}

function Details(p: { summary: Summary; health: CoreHealth; connected: boolean; restart: { restarting: boolean; error: string | null } }) {
  const { info, core, ptyHost } = p.health;
  const proc = (x: { memory: number; cpu: number } | null) => (x ? [formatBytes(x.memory), x.cpu >= BUSY_CPU ? `${x.cpu.toFixed(0)}% CPU` : null].filter(Boolean).join(" · ") : "—");
  const rows: [string, string][] = info
    ? [
        ["Uptime", formatUptime(Date.now() - info.startedAt)],
        ["Core", proc(core)],
        ["PTY host", info.ptyHost ? proc(ptyHost) : "not running"],
      ]
    : [];
  const stall = recentStall(info?.stalls);
  return (
    <Stack gap={2} pad={3}>
      <Text>{p.summary.detail}</Text>
      {p.restart.error && <Text tone="warning">{p.restart.error}</Text>}
      {stall && <Text tone="warning">{`Froze ${(stall.ms / 1000).toFixed(1)} s in ${stall.in}.`}</Text>}
      {rows.length > 0 && <KeyValue items={rows} />}
      <Inline gap={1.5}>
        <Button variant={p.health.outdated || p.health.unresponsive || !p.connected ? "primary" : "default"} disabled={p.restart.restarting} onClick={() => void restartCore()}>
          {p.restart.restarting ? "Restarting…" : "Restart Core"}
        </Button>
        <Button onClick={() => cmd.openTaskManager()}>
          Task Manager
        </Button>
      </Inline>
    </Stack>
  );
}
