// Recent Commands, a built-in widget package (docs/56, "Built-ins and dogfooding"; the native
// Commands view's job): every command this workspace's terminals ran (or every workspace's),
// from the log's command events. Running ones first, then the rest, newest first; a failed one
// says its exit status. A click goes to its terminal; Run Again opens a terminal in its folder
// with the command typed, not run (cmd.terminals.open, API 1.1). The title menu switches the
// scope and Failed Only, kept per window.

import { Window, View, List, ListSection, ListRow, ListRowIcon, ListRowContent, ListRowEnd, Chip, useEvents, useData, useTerminals, useWorkspace, useStoredState, useNow, fmt, cmd, type Event } from "@cmd/widget-api";

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

/** This workspace's commands, live. */
function Here(p: { failedOnly: boolean; scope: Scope; setScope: (s: Scope) => void; setFailedOnly: (f: boolean) => void }) {
  const runs = useEvents({ types: ["command"], limit: 300 }).map(runOf);
  return <Commands {...p} runs={runs} />;
}

/** Every workspace's commands: the log asked every few seconds (a live query reads one workspace). */
function Everywhere(p: { failedOnly: boolean; scope: Scope; setScope: (s: Scope) => void; setFailedOnly: (f: boolean) => void }) {
  const { data, error } = useData(() => cmd.events.query({ types: ["command"], scope: "all", limit: 300 }), { every: 5 });
  return <Commands {...p} runs={(data ?? []).map(runOf)} error={error?.message} />;
}

function Commands({ runs: all, failedOnly, scope, setScope, setFailedOnly, error }: { runs: Run[]; failedOnly: boolean; scope: Scope; setScope: (s: Scope) => void; setFailedOnly: (f: boolean) => void; error?: string }) {
  const terminals = useTerminals({ scope });
  const ws = useWorkspace();
  const anyRunning = all.some((r) => r.endedAt === null);
  const now = useNow(anyRunning ? 1000 : 15_000);
  const open = new Set(terminals.map((t) => t.id));
  const runs = newestFirst(all).filter((r) => !failedOnly || r.endedAt === null || failed(r));
  const running = runs.filter((r) => r.endedAt === null);
  const done = runs.filter((r) => r.endedAt !== null);
  const failures = done.filter(failed).length;
  const status = error ? `Stale · ${error}` : failures ? `${failures} failed` : running.length ? `${running.length} running` : null;

  /** In a folder of this workspace's (where a terminal may open): the workspace's own commands. */
  const here = (r: Run) => !!ws?.root && r.workspaceId === ws.id && (r.cwd === ws.root || r.cwd.startsWith(ws.root + "/"));
  const go = (r: Run) => r.terminalId && open.has(r.terminalId) && void cmd.windows.select(r.terminalId).catch(() => {});
  const again = (r: Run) => void cmd.terminals.open({ cwd: r.cwd, command: r.command ?? "" }).catch(() => {});

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
          { label: "Show Terminal", disabled: !(r.terminalId && open.has(r.terminalId)), run: () => go(r) },
          { label: "Run Again", disabled: !r.command || !here(r), run: () => again(r) },
        ]}
      >
        <ListRowIcon icon="terminal" light={r.endedAt === null ? "working" : bad ? "danger" : undefined} />
        <ListRowContent title={r.command ?? "Command"} mono detail={state} tone={bad ? "danger" : undefined} />
        <ListRowEnd>
          {r.branch && <Chip>{r.branch}</Chip>}
          {r.endedAt !== null && <Chip>{fmt.ago(r.endedAt, now)}</Chip>}
        </ListRowEnd>
      </ListRow>
    );
  };

  const empty = failedOnly
    ? { icon: "terminal", title: "Nothing failed", text: "Commands that fail show up here." }
    : { icon: "terminal", title: "No commands yet", text: scope === "all" ? "Commands you run in terminals show up here." : "Commands you run in this workspace's terminals show up here." };

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
      <View state={runs.length ? null : empty}>
        <List>
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
        </List>
      </View>
    </Window>
  );
}

export default function RecentCommands() {
  const [scope, setScope] = useStoredState<Scope>("scope", "workspace");
  const [failedOnly, setFailedOnly] = useStoredState<boolean>("failedOnly", false);
  const p = { scope, setScope, failedOnly, setFailedOnly };
  return scope === "all" ? <Everywhere {...p} /> : <Here {...p} />;
}
