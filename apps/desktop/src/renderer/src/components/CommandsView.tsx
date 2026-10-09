// Commands, a built-in widget (docs/16-widgets.md): every command the terminals
// of this workspace (or all of them) ran, from the shell integration (CommandRun,
// core/commands.ts). Running ones first, then the rest, newest first; a failed
// one says its exit status. A click goes to its terminal; Run Again types it there.

import { Chip, EmptyState, IconButton, ListRow, ListSection, ListValue, Panel, PanelBody } from "@cmd/ui";
import { useEffect, useMemo, useState } from "react";
import type { CommandRun } from "@cmd/protocol";
import { commandRunOf } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { copy, newTerminalIn } from "../actions.ts";
import { showContextMenu } from "../context.ts";
import { whereOf } from "../model.ts";
import { useStore, subscribeData } from "../store.ts";
import { durationText, goTo, scopeOf, useWidgetStatus } from "../widgets.ts";
import type { WindowViewProps } from "../windows/registry.ts";
import { shortAgo } from "./SidebarRows.tsx";

/** Exit statuses that mean someone stopped it (⌃C, kill): not a failure. */
const STOPPED = new Set([130, 137, 143]);
const failed = (r: CommandRun) => r.exitCode !== null && r.exitCode !== 0 && !STOPPED.has(r.exitCode);

/** The log: a live query over command events (runs are recorded when they start and updated when they end). */
function useCommands(): CommandRun[] {
  const [runs, setRuns] = useState<CommandRun[]>([]);
  useEffect(
    () =>
      subscribeData({ types: ["command"], by: "time", order: "desc", limit: 300 }, (events, initial) =>
        setRuns((rs) => {
          const incoming = events.map(commandRunOf);
          const base = initial ? [] : rs;
          return [...incoming, ...base.filter((r) => !incoming.some((x) => x.id === r.id))].sort((a, b) => b.startedAt - a.startedAt).slice(0, 300);
        }),
      ),
    [],
  );
  return runs;
}

export function CommandsView({ win }: WindowViewProps) {
  const s = useStore();
  const all = useCommands();
  const scope = scopeOf(win.state.scope);
  const failedOnly = win.state.failedOnly === true;
  const [now, setNow] = useState(Date.now());
  const anyRunning = all.some((r) => r.endedAt === null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), anyRunning ? 1000 : 15_000);
    return () => clearInterval(t);
  }, [anyRunning]);

  const runs = useMemo(() => all.filter((r) => (scope === "all" || r.workspaceId === win.workspaceId) && (!failedOnly || r.endedAt === null || failed(r))), [all, scope, failedOnly, win.workspaceId]);
  const running = runs.filter((r) => r.endedAt === null);
  const done = runs.filter((r) => r.endedAt !== null);
  const failures = done.filter(failed).length;
  useWidgetStatus(win.id, failures > 0 ? `${failures} failed` : running.length > 0 ? `${running.length} running` : null);

  /** Typed into its terminal, if that is still open and back at the prompt. */
  const canRerun = (r: CommandRun) => {
    const pane = s.panes.get(r.paneId);
    return !!r.command && !!pane && pane.exitCode === null && !all.some((x) => x.paneId === r.paneId && x.endedAt === null);
  };
  const rerun = (r: CommandRun) => {
    if (!canRerun(r)) return;
    void cmd.call("pane.write", { paneId: r.paneId, data: `${r.command}\r` }).catch(() => {});
    goTo(r.paneId, r.workspaceId);
  };
  const rowMenu = (r: CommandRun) =>
    void showContextMenu([
      { label: "Show Terminal", enabled: s.panes.has(r.paneId), run: () => goTo(r.paneId, r.workspaceId) },
      { label: "Run Again", enabled: canRerun(r), run: () => rerun(r) },
      "-",
      { label: "Copy Command", enabled: !!r.command, run: () => copy(r.command ?? "") },
      { label: "New Terminal Here", run: () => void newTerminalIn(r.cwd) },
    ]);

  const row = (r: CommandRun) => {
    const bad = failed(r);
    const took = durationText((r.endedAt ?? now) - r.startedAt);
    const state =
      r.endedAt === null ? `Running · ${took}`
      : bad ? `Failed · exit ${r.exitCode} · ${took}`
      : r.exitCode !== null && STOPPED.has(r.exitCode) ? `Stopped · ${took}`
      : took;
    const sp = s.workspaces.get(r.workspaceId);
    const where = whereOf(r.git, r.cwd, sp);
    const workspace = scope === "all" ? sp?.name : undefined;
    return (
      <ListRow
        key={r.id}
        icon="terminal"
        light={r.endedAt === null ? "working" : bad ? "danger" : undefined}
        title={r.command ?? "Command"}
        mono
        detail={[state, workspace].filter(Boolean).join(" · ")}
        tone={bad ? "danger" : undefined}
        tip={r.cwd}
        end={
          <>
            {where && <Chip hue={where.hue}>{where.text}</Chip>}
            {r.endedAt !== null && <ListValue>{shortAgo(r.endedAt, now)}</ListValue>}
          </>
        }
        hover={<IconButton size="sm" icon="arrow.clockwise" label="Run Again" disabled={!canRerun(r)} onClick={() => rerun(r)} />}
        onClick={() => goTo(r.paneId, r.workspaceId)}
        onContextMenu={() => rowMenu(r)}
      />
    );
  };

  return (
    <Panel>
      <PanelBody>
        {running.length > 0 && (
          <ListSection title="Running" count={running.length}>
            {running.map(row)}
          </ListSection>
        )}
        {done.length > 0 && (
          <ListSection title={failedOnly ? "Failed" : "Finished"} count={done.length}>
            {done.map(row)}
          </ListSection>
        )}
        {runs.length === 0 && (
          <EmptyState compact icon="terminal" title={failedOnly ? "Nothing failed" : "No commands yet"}>
            {failedOnly ? "Commands that fail show up here." : scope === "all" ? "Commands you run in terminals show up here." : "Commands you run in this workspace's terminals show up here."}
          </EmptyState>
        )}
      </PanelBody>
    </Panel>
  );
}
