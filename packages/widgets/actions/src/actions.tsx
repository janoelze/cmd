// Run Scripts, a built-in widget package (docs/57; the native Workspace Actions' job for listing,
// running and stopping): how to run the project in this workspace's folder, from its own files
// (useActions, live), the main one on its own, the rest in sections by kind (Dev, Test, Build…)
// and a monorepo's packages each in their own. A section folds with a click on its heading, as
// natively: a package's start folded, the rest open; what was toggled is kept per window.
// A click runs one in its own terminal (cmd.actions.run, which asks or follows the permission
// levels); while it runs, a click goes to its terminal, and Stop (cmd.actions.stop) and Restart
// (cmd.actions.run with restart, API 1.2) are on its row. Whether it runs, failed or finished,
// its terminal and a dev server's address are the action's own (API 1.2's run fields), from
// wherever it was started; how long comes from the command events of its terminal. Copy Command
// puts its command on the clipboard. A risky action (a deploy, a publish) is shown, but a
// widget can't run it.

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
  LinkButton,
  Button,
  Badge,
  StatusLine,
  useActions,
  useEvents,
  useWorkspace,
  useStoredState,
  useNow,
  fmt,
  cmd,
  type WorkspaceAction,
  type Event,
} from "@cmd/widget-api";
import { useState } from "react";

/** How a run is now. */
export type RunState = { kind: "running"; since: number | null } | { kind: "failed"; exitCode: number; took: number | null } | { kind: "done"; took: number | null } | { kind: "stopped"; took: number | null };

/** Exit statuses that mean someone stopped it (⌃C, kill): not a failure. */
const STOPPED = new Set([130, 137, 143]);
/** Past this many actions the toolbar has a filter. */
export const FILTER_FROM = 12;

/** Sections by kind, in the native view's order and words: working on it first, shipping and cleaning up last. */
export const KINDS: { kind: string; title: string; icon: string }[] = [
  { kind: "dev", title: "Dev", icon: "play" },
  { kind: "test", title: "Test", icon: "checkmark.circle" },
  { kind: "build", title: "Build", icon: "hammer" },
  { kind: "check", title: "Check", icon: "checklist" },
  { kind: "run", title: "Other", icon: "terminal" },
  { kind: "setup", title: "Setup", icon: "wrench.and.screwdriver" },
  { kind: "deploy", title: "Deploy", icon: "paperplane" },
  { kind: "clean", title: "Clean", icon: "trash" },
  { kind: "agent", title: "Agent Skills", icon: "sparkles" },
];
const kindOf = (a: WorkspaceAction) => KINDS.find((k) => k.kind === a.kind) ?? KINDS.find((k) => k.kind === "run")!;

/**
 * A run's state: running or how it ended, from the action (API 1.2: `running`, `exitCode`);
 * how long, from the newest command in its terminal. Null when it hasn't run here.
 */
export function runState(a: WorkspaceAction, events: readonly Event[]): RunState | null {
  if (!a.terminalId) return null;
  const mine = events.filter((e) => e.terminalId === a.terminalId);
  const e = mine.reduce<Event | null>((x, y) => (!x || y.at >= x.at ? y : x), null);
  if (a.running) return { kind: "running", since: e && (e.until === null || e.until === undefined) ? e.at : null };
  const took = e && typeof e.until === "number" ? e.until - e.at : null;
  const code = a.exitCode ?? null;
  if (code !== null && STOPPED.has(code)) return { kind: "stopped", took };
  return code ? { kind: "failed", exitCode: code, took } : { kind: "done", took };
}

/** "localhost:5173" for an address. */
export const shortUrl = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "");

export default function RunScripts() {
  const ws = useWorkspace();
  const actions = useActions();
  const commands = useEvents({ types: ["command"], limit: 200 });
  const [query, setQuery] = useState("");
  // Sections toggled from how they start (open, or folded for a package's), kept per window as the native view keeps them.
  const [toggled, setToggled] = useStoredState<string[]>("toggled", []);
  const toggle = (key: string) => setToggled(toggled.includes(key) ? toggled.filter((k) => k !== key) : [...toggled, key]);
  const states = new Map(actions.map((a) => [a.name, runState(a, commands)]));
  const running = [...states.values()].filter((s) => s?.kind === "running").length;
  const failed = [...states.values()].filter((s) => s?.kind === "failed").length;
  const now = useNow(running ? 1000 : 15_000);

  /** The person's own no says nothing; anything else says why. */
  const said = (what: string) => (e: unknown) => {
    if (!(e instanceof ApiCallError && e.code === "denied")) void cmd.notify.send({ key: "run", title: `${what} · couldn't`, body: e instanceof Error ? e.message : String(e) }).catch(() => {});
  };
  const show = (a: WorkspaceAction) => a.terminalId && void cmd.windows.select(a.terminalId).catch(() => {});
  const run = (a: WorkspaceAction) => void cmd.actions.run(a.name).catch(said(a.name));
  const restart = (a: WorkspaceAction) => void cmd.actions.run(a.name, { restart: true }).catch(said(a.name));
  const stop = (a: WorkspaceAction) => void cmd.actions.stop(a.name).catch(said(a.name));
  const copy = (a: WorkspaceAction) => a.command && void cmd.clipboard.write(a.command).catch(() => {});
  const open = (url: string) => void cmd.windows.open(url).catch(() => {});

  const row = (a: WorkspaceAction, main = false) => {
    const s = states.get(a.name) ?? null;
    const on = s?.kind === "running";
    const state =
      s?.kind === "running" ? (s.since !== null ? fmt.dur((now - s.since) / 1000) : null)
      : s?.kind === "failed" ? `exit ${s.exitCode}`
      : (s?.kind === "done" || s?.kind === "stopped") && s.took !== null ? fmt.dur(s.took / 1000)
      : null;
    return (
      <ListRow
        key={a.name}
        dim={a.risky}
        tip={a.risky ? "Deploys or publishes: run it from a terminal" : (a.command ?? a.title)}
        onClick={a.risky ? undefined : () => (on ? show(a) : run(a))}
        menu={[
          ...(a.risky ? [] : on ? [{ label: "Show Terminal", run: () => show(a) }, { label: "Restart", run: () => restart(a) }, { label: "Stop", run: () => stop(a) }] : [{ label: "Run", run: () => run(a) }]),
          ...(!on && a.terminalId ? [{ label: "Show Terminal", run: () => show(a) }] : []),
          ...(a.url ? [{ label: `Open ${shortUrl(a.url)}`, run: () => open(a.url!) }] : []),
          ...(a.command ? [{ separator: true as const }, { label: "Copy Command", run: () => copy(a) }] : []),
        ]}
      >
        <ListRowIcon icon={a.risky ? "exclamationmark.triangle" : kindOf(a).icon} light={on ? "working" : s?.kind === "failed" ? "danger" : undefined} />
        <ListRowContent title={a.name} mono detail={a.title !== a.name ? a.title : null} tone={s?.kind === "failed" ? "danger" : undefined} />
        <ListRowEnd>
          {a.risky && <Badge size="sm" tone="warning">risky</Badge>}
          {a.url && (
            <LinkButton tone="accent" onClick={() => open(a.url!)}>
              {shortUrl(a.url)}
            </LinkButton>
          )}
          {state && <ListValue>{state}</ListValue>}
          {main && !on && (
            <Button size="sm" variant="primary" icon="play.fill" onClick={() => run(a)}>
              Run
            </Button>
          )}
        </ListRowEnd>
        {!a.risky && (on || !main) && (
          <ListRowActions>
            {on ? (
              <>
                <IconButton size="sm" icon="arrow.clockwise" label="Restart" onClick={() => restart(a)} />
                <IconButton size="sm" icon="stop.fill" label="Stop" onClick={() => stop(a)} />
              </>
            ) : (
              <IconButton size="sm" icon="play.fill" label="Run" onClick={() => run(a)} />
            )}
          </ListRowActions>
        )}
      </ListRow>
    );
  };

  const q = query.trim().toLowerCase();
  const matches = q ? actions.filter((a) => a.name.toLowerCase().includes(q) || a.title.toLowerCase().includes(q) || !!a.command?.toLowerCase().includes(q)) : actions;
  const safe = actions.filter((a) => !a.risky);
  // The main action is cmd's (`primary`, usually dev); an older cmd says none, so the first that isn't risky.
  const main = q ? undefined : (safe.find((a) => a.primary) ?? (actions.some((a) => a.primary !== undefined) ? undefined : safe[0]));
  const rest = safe.filter((a) => a !== main);
  const risky = actions.filter((a) => a.risky);
  const pinned = rest.filter((a) => a.pinned);
  // The root's by kind; a monorepo's packages each in a section of their own, as Workspace Actions has them.
  const byKind = KINDS.map((k) => ({ ...k, rows: rest.filter((a) => !a.pinned && !a.package && kindOf(a) === k) })).filter((k) => k.rows.length);
  const packages = [...new Set(rest.filter((a) => !a.pinned && a.package).map((a) => a.package!))].sort();

  /** A section that folds: open unless toggled, or (`closed`) folded unless toggled. */
  const section = (key: string, title: string, rows: WorkspaceAction[], closed = false) =>
    rows.length > 0 && (
      <ListSection key={key} title={title} count={rows.length} open={closed ? toggled.includes(key) : !toggled.includes(key)} onToggle={() => toggle(key)}>
        {rows.map((a) => row(a))}
      </ListSection>
    );

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
              {section("pinned", "Pinned", pinned)}
              {byKind.map((k) => section(`kind:${k.kind}`, k.title, k.rows))}
              {packages.map((pk) => section(`pkg:${pk}`, pk, rest.filter((a) => !a.pinned && a.package === pk), true))}
              {section("risky", "Run From a Terminal", risky)}
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
