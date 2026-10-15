// Run Scripts, a built-in widget package (docs/57, wave 1; the native Workspace Actions' job for
// listing and running): how to run the project in this workspace's folder, from its own files
// (useActions, live), the first one on its own as the main action. A click runs one in its own
// terminal (cmd.actions.run, API 1.1, which asks or follows the permission levels); while it
// runs, a click goes to its terminal. Whether it runs, failed or finished comes from the log's
// command events in the terminal it ran in, kept per window so it holds across a reload. A risky
// action (a deploy, a publish) is shown, but a widget can't run it.

import {
  ApiCallError,
  Window,
  View,
  WindowToolbar,
  ToolbarSearchField,
  List,
  ListGroup,
  ListSection,
  ListRow,
  ListRowIcon,
  ListRowContent,
  ListRowEnd,
  ListRowActions,
  ListValue,
  IconButton,
  Button,
  Badge,
  StatusLine,
  useActions,
  useEvents,
  useTerminals,
  useWorkspace,
  useStoredState,
  useNow,
  fmt,
  cmd,
  type WorkspaceAction,
  type Event,
} from "@cmd/widget-api";
import { useState } from "react";

/** Where an action last ran from this window: its terminal, and when. */
type Ran = { terminalId: string; at: number };
/** How a run is now. */
export type RunState = { kind: "running"; since: number } | { kind: "failed"; exitCode: number; took: number } | { kind: "done"; took: number } | { kind: "stopped"; took: number };

/** Exit statuses that mean someone stopped it (⌃C, kill): not a failure. */
const STOPPED = new Set([130, 137, 143]);
/** Past this many actions the toolbar has a filter. */
export const FILTER_FROM = 12;

/** A run's state from the command events of its terminal since it ran: the latest one. Null when none came yet. */
export function runState(ran: Ran | undefined, events: readonly Event[]): RunState | null {
  if (!ran) return null;
  const mine = events.filter((e) => e.terminalId === ran.terminalId && e.at >= ran.at - 1000);
  const e = mine.reduce<Event | null>((a, b) => (!a || b.at >= a.at ? b : a), null);
  if (!e) return null;
  if (e.until === null || e.until === undefined) return { kind: "running", since: e.at };
  const took = e.until - e.at;
  const code = typeof e.data.exitCode === "number" ? e.data.exitCode : null;
  if (code !== null && STOPPED.has(code)) return { kind: "stopped", took };
  return code ? { kind: "failed", exitCode: code, took } : { kind: "done", took };
}

export default function RunScripts() {
  const ws = useWorkspace();
  const actions = useActions();
  const terminals = useTerminals();
  const commands = useEvents({ types: ["command"], limit: 200 });
  const [ran, setRan] = useStoredState<Record<string, Ran>>("ran", {});
  const [query, setQuery] = useState("");
  const open = new Set(terminals.map((t) => t.id));
  const states = new Map(actions.map((a) => [a.name, runState(ran[a.name], commands)]));
  // A run whose terminal closed isn't running any more.
  for (const [name, s] of states) if (s?.kind === "running" && !open.has(ran[name]!.terminalId)) states.set(name, null);
  const running = [...states.values()].filter((s) => s?.kind === "running").length;
  const failed = [...states.values()].filter((s) => s?.kind === "failed").length;
  const now = useNow(running ? 1000 : 15_000);

  const show = (a: WorkspaceAction) => void cmd.windows.select(ran[a.name]!.terminalId).catch(() => {});
  const run = (a: WorkspaceAction) => {
    const at = Date.now();
    void cmd.actions.run(a.name).then(
      (r) => setRan({ ...ran, [a.name]: { terminalId: r.terminalId, at: r.started ? at : (ran[a.name]?.at ?? at) } }),
      (e: unknown) => {
        // The person's own no says nothing; anything else says why.
        if (!(e instanceof ApiCallError && e.code === "denied")) void cmd.notify.send({ key: "run", title: `${a.name} · couldn't run`, body: e instanceof Error ? e.message : String(e) }).catch(() => {});
      },
    );
  };

  const row = (a: WorkspaceAction, main = false) => {
    const s = states.get(a.name) ?? null;
    const on = s?.kind === "running";
    const state =
      s?.kind === "running" ? fmt.dur((now - s.since) / 1000)
      : s?.kind === "failed" ? `exit ${s.exitCode}`
      : s?.kind === "done" || s?.kind === "stopped" ? fmt.dur(s.took / 1000)
      : null;
    return (
      <ListRow
        key={a.name}
        dim={a.risky}
        tip={a.risky ? "Deploys or publishes: run it from a terminal" : a.title}
        onClick={a.risky ? undefined : () => (on ? show(a) : run(a))}
        menu={[
          ...(a.risky ? [] : [{ label: on ? "Show Terminal" : "Run", run: () => (on ? show(a) : run(a)) }]),
          ...(!on && ran[a.name] && open.has(ran[a.name]!.terminalId) ? [{ label: "Show Terminal", run: () => show(a) }] : []),
        ]}
      >
        <ListRowIcon icon={main ? "play.fill" : a.risky ? "exclamationmark.triangle" : "terminal"} light={on ? "working" : s?.kind === "failed" ? "danger" : undefined} />
        <ListRowContent title={a.name} mono detail={a.title !== a.name ? a.title : null} tone={s?.kind === "failed" ? "danger" : undefined} />
        <ListRowEnd>
          {a.risky && <Badge size="sm" tone="warning">risky</Badge>}
          {state && <ListValue>{state}</ListValue>}
          {main && !on && (
            <Button size="sm" variant="primary" icon="play.fill" onClick={() => run(a)}>
              Run
            </Button>
          )}
        </ListRowEnd>
        {!a.risky && !main && (
          <ListRowActions>
            {on ? <IconButton size="sm" icon="macwindow" label="Show Terminal" onClick={() => show(a)} /> : <IconButton size="sm" icon="play.fill" label="Run" onClick={() => run(a)} />}
          </ListRowActions>
        )}
      </ListRow>
    );
  };

  const q = query.trim().toLowerCase();
  const matches = q ? actions.filter((a) => a.name.toLowerCase().includes(q) || a.title.toLowerCase().includes(q)) : actions;
  const safe = actions.filter((a) => !a.risky);
  const main = q ? undefined : safe[0];
  const rest = safe.filter((a) => a !== main);
  const risky = actions.filter((a) => a.risky);

  const state =
    ws && !ws.root ? { icon: "play.rectangle", title: "No folder", text: "This workspace has no folder." }
    : actions.length === 0 ? { icon: "play.rectangle", title: "No scripts here", text: "Scripts in package.json, a Makefile, a justfile and similar files show up here." }
    : q && !matches.length ? { kind: "noResults" as const, title: "No matches", text: `Nothing here is called “${query.trim()}”.`, action: { label: "Clear Filter", run: () => setQuery("") } }
    : null;

  return (
    <Window status={running ? `${running} running` : failed ? `${failed} failed` : null}>
      <View state={state}>
        {actions.length > FILTER_FROM && (
          <WindowToolbar label="Actions">
            <ToolbarSearchField value={query} placeholder="Filter actions" count={q ? String(matches.length) : undefined} onChange={setQuery} />
          </WindowToolbar>
        )}
        <List>
          {q ? (
            <ListSection title="Matches" count={matches.length}>
              {matches.map((a) => row(a))}
            </ListSection>
          ) : (
            <>
              {main && <ListGroup>{row(main, true)}</ListGroup>}
              {rest.length > 0 && (
                <ListSection title="Scripts" count={rest.length}>
                  {rest.map((a) => row(a))}
                </ListSection>
              )}
              {risky.length > 0 && (
                <ListSection title="Run From a Terminal" count={risky.length}>
                  {risky.map((a) => row(a))}
                </ListSection>
              )}
            </>
          )}
        </List>
        <StatusLine>
          {[`${actions.length} ${actions.length === 1 ? "action" : "actions"}`, running && `${running} running`, failed && `${failed} failed`].filter(Boolean).join(" · ")}
        </StatusLine>
      </View>
    </Window>
  );
}
