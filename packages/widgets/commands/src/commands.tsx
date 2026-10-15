// Recent Commands, a built-in widget package (docs/56, "Built-ins and dogfooding"; the native
// Commands view's job): every command this workspace's terminals ran (or every workspace's),
// from the log's command events. Running ones first, then the rest, newest first; a failed one
// says its exit status. A click goes to its terminal; Run Again (on hover, and in the row's
// menu) opens a terminal in its folder with the command typed, not run (cmd.terminals.open,
// API 1.1); refused, a notification says why. The menu also copies the command and opens a
// terminal in its folder. The title menu switches the scope and Failed Only, kept per window.

import { ApiCallError, Window, Panel, PanelBody, ListSection, ListRow, ListRowIcon, ListRowContent, ListRowEnd, ListRowActions, ListValue, IconButton, EmptyState, Chip, useEvents, useTerminals, useWorkspace, useStoredState, useNow, fmt, cmd, type Event } from "@cmd/widget-api";

type Scope = "workspace" | "all";

/** A command run, as the log keeps it. */
export interface Run {
  key: string;
  command: string | null;
  cwd: string;
  branch: string | null;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  terminalId: string | null;
  workspaceId: string | null;
}

/** Exit statuses that mean someone stopped it (⌃C, kill): not a failure. */
const STOPPED = new Set([130, 137, 143]);
export const failed = (r: Run) => r.exitCode !== null && r.exitCode !== 0 && !STOPPED.has(r.exitCode);

export function runOf(e: Event): Run {
  const d = e.data as { command?: string | null; cwd?: string; exitCode?: number | null; git?: { branch?: string | null } | null };
  return { key: e.key ?? String(e.id), command: d.command ?? null, cwd: d.cwd ?? "", branch: d.git?.branch ?? null, exitCode: d.exitCode ?? null, startedAt: e.at, endedAt: e.until ?? null, terminalId: e.terminalId ?? null, workspaceId: e.workspaceId };
}

const newestFirst = (runs: Run[]) => [...runs].sort((a, b) => b.startedAt - a.startedAt);

export default function RecentCommands() {
  const [scope, setScope] = useStoredState<Scope>("scope", "workspace");
  const [failedOnly, setFailedOnly] = useStoredState<boolean>("failedOnly", false);
  // This workspace's commands, or every workspace's (`workspace: ["all"]`), live.
  const all = useEvents({ types: ["command"], limit: 300, ...(scope === "all" ? { scope } : {}) }).map(runOf);
  const terminals = useTerminals({ scope });
  const ws = useWorkspace();
  const anyRunning = all.some((r) => r.endedAt === null);
  const now = useNow(anyRunning ? 1000 : 15_000);
  const live = new Set(terminals.map((t) => t.id));
  const runs = newestFirst(all).filter((r) => !failedOnly || r.endedAt === null || failed(r));
  const running = runs.filter((r) => r.endedAt === null);
  const done = runs.filter((r) => r.endedAt !== null);
  const failures = done.filter(failed).length;
  const status = failures ? `${failures} failed` : running.length ? `${running.length} running` : null;

  /** In a folder of this workspace's (where a terminal may open): the workspace's own commands. */
  const here = (r: Run) => !!ws?.root && r.workspaceId === ws.id && (r.cwd === ws.root || r.cwd.startsWith(ws.root + "/"));
  const go = (r: Run) => r.terminalId && live.has(r.terminalId) && void cmd.windows.select(r.terminalId).catch(() => {});
  // A refusal says why (a folder that stays private, a command cmd won't type); the person's own no says nothing.
  const open = (r: Run, command: string | null, title: string) =>
    void cmd.terminals.open(command ? { cwd: r.cwd, command } : { cwd: r.cwd }).catch((e: unknown) => {
      if (!(e instanceof ApiCallError && e.code === "denied")) void cmd.notify.send({ key: "run-again", title: `${title} · couldn't open`, body: e instanceof Error ? e.message : String(e) }).catch(() => {});
    });
  const again = (r: Run) => open(r, r.command ?? "", "Run Again");

  const row = (r: Run) => {
    const bad = failed(r);
    const took = fmt.dur(((r.endedAt ?? now) - r.startedAt) / 1000);
    const state =
      r.endedAt === null ? `Running · ${took}`
      : bad ? `Failed · exit ${r.exitCode} · ${took}`
      : r.exitCode !== null && STOPPED.has(r.exitCode) ? `Stopped · ${took}`
      : took;
    return (
      <ListRow
        key={r.key}
        tip={r.cwd}
        onClick={() => go(r)}
        menu={[
          { label: "Show Terminal", disabled: !(r.terminalId && live.has(r.terminalId)), run: () => go(r) },
          { label: "Run Again", disabled: !r.command || !here(r), run: () => again(r) },
          { separator: true },
          { label: "Copy Command", disabled: !r.command, run: () => void cmd.clipboard.write(r.command ?? "").catch(() => {}) },
          { label: "New Terminal Here", disabled: !here(r), run: () => open(r, null, "New Terminal Here") },
        ]}
      >
        <ListRowIcon icon="terminal" light={r.endedAt === null ? "working" : bad ? "danger" : undefined} />
        <ListRowContent title={r.command ?? "Command"} mono detail={state} tone={bad ? "danger" : undefined} />
        <ListRowEnd>
          {r.branch && <Chip>{r.branch}</Chip>}
          {r.endedAt !== null && <ListValue>{fmt.ago(r.endedAt, now)}</ListValue>}
        </ListRowEnd>
        <ListRowActions>
          <IconButton size="sm" icon="arrow.clockwise" label="Run Again" disabled={!r.command || !here(r)} onClick={() => again(r)} />
        </ListRowActions>
      </ListRow>
    );
  };


  return (
    <Window
      status={status}
      menu={[
        { label: "This Workspace", checked: scope === "workspace", run: () => setScope("workspace") },
        { label: "All Workspaces", checked: scope === "all", run: () => setScope("all") },
        { separator: true },
        { label: "Failed Only", checked: failedOnly, run: () => setFailedOnly(!failedOnly) },
      ]}
    >
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
            <EmptyState
              compact
              icon="terminal"
              title={failedOnly ? "Nothing failed" : "No commands yet"}
              text={failedOnly ? "Commands that fail show up here." : scope === "all" ? "Commands you run in terminals show up here." : "Commands you run in this workspace's terminals show up here."}
            />
          )}
        </PanelBody>
      </Panel>
    </Window>
  );
}
