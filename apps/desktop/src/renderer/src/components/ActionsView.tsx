// Workspace Actions, a built-in widget (docs/39): how to run the project in
// this workspace's folder (or the one the widget was given), from its own files,
// grouped by what they do, the main one first. A click runs one in its own
// terminal (a server already running: goes to it); risky ones ask first;
// a dev server's address opens in a browser window. The core finds, ranks,
// describes and runs them (core/actions/); this only shows and asks.
//
// ActionsView gets the data and does things; Actions draws it (the window-design
// skill's actions window: the filter in the toolbar, the main action first, grouped
// sections, where it runs in the footer), so ActionsView.story.tsx can show every state.

import { Button, CodeBlock, ConfirmDialog, Icon, IconButton, LinkButton, List, ListGroup, ListRow, ListSection, ListValue, Spinner, StatusLine, ToolbarSearchField, View, WindowToolbar, Callout, type ViewStateSpec } from "@cmd/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type ActionKind, type ActionRun, type ActionsList, type PaneId, type WorkspaceId, type WorkspaceAction } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { actionsRootOf, lastLists, runAction } from "../workspaceActions.ts";
import { copy, newBrowser, openFileAt, openLink } from "../actions.ts";
import { showContextMenu } from "../context.ts";
import { useAiStatus } from "../ai/status.ts";
import { shortPath } from "../model.ts";
import { onActionsChanged, useStore } from "../store.ts";
import { durationText, goTo, setWidgetState, useWidgetStatus } from "../widgets.ts";
import type { WindowViewProps } from "../windows/registry.ts";

const KIND: Record<ActionKind, { title: string; icon: string }> = {
  dev: { title: "Dev", icon: "play" },
  test: { title: "Test", icon: "checkmark.circle" },
  build: { title: "Build", icon: "hammer" },
  check: { title: "Check", icon: "checklist" },
  run: { title: "Other", icon: "terminal" },
  setup: { title: "Setup", icon: "wrench.and.screwdriver" },
  deploy: { title: "Deploy", icon: "paperplane" },
  clean: { title: "Clean", icon: "trash" },
  agent: { title: "Agent Skills", icon: "sparkles" },
};
const AGENT_TITLE: Record<string, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", qwen: "Qwen", copilot: "Copilot" };

/** Sections in this order: working on it first, shipping and cleaning up last (every kind has one). */
const ORDER: ActionKind[] = ["dev", "test", "build", "check", "run", "setup", "deploy", "clean", "agent"];

/** Exit statuses that mean someone stopped it (⌃C, kill): not a failure. */
const STOPPED = new Set([130, 137, 143]);
const failed = (r: ActionRun | undefined) => !!r && r.endedAt !== null && r.exitCode !== null && r.exitCode !== 0 && !STOPPED.has(r.exitCode);
const running = (r: ActionRun | undefined) => !!r && r.endedAt === null;
/** "localhost:5173" for a chip. */
const shortUrl = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** actions.list for a folder, again whenever the core says it changed or the connection comes back. */
function useActions(root: string | null): { list: ActionsList | null; error: string | null } {
  const connected = useStore().connected;
  const [list, setList] = useState<ActionsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!root || !connected) return;
    let live = true;
    let busy = false;
    let again = false;
    const load = () => {
      if (busy) return void (again = true);
      busy = true;
      cmd
        .call("actions.list", { path: root })
        .then((l) => live && (setList(l), setError(null)))
        .catch((e: Error) => live && setError(e.message))
        .finally(() => {
          busy = false;
          if (again && live) (again = false), load();
        });
    };
    load();
    const off = onActionsChanged((r) => r === root && load());
    // Ranking follows what you type in the terminals; read it again now and then.
    const t = setInterval(load, 60_000);
    return () => {
      live = false;
      off();
      clearInterval(t);
    };
  }, [root, connected]);
  return { list: list?.root === root ? list : null, error };
}

/** What Actions draws, and what it asks for. */
export interface ActionsProps {
  /** The folder; null: the workspace has none. */
  root: string | null;
  /** Null while it loads (or when it couldn't: error). */
  list: ActionsList | null;
  error: string | null;
  now: number;
  /** Sections the person opened or closed (their keys). */
  toggled: ReadonlySet<string>;
  onToggle: (key: string) => void;
  /** Show the branch and folder in the footer: the actions run in another checkout than the workspace's. */
  showWhere: boolean;
  /** Offer to set up AI (nothing is described yet and AI isn't ready). */
  offerAi: boolean;
  onSetUpAi: () => void;
  onRun: (a: WorkspaceAction, o?: { restart?: boolean }) => void;
  onStop: (a: WorkspaceAction) => void;
  onMenu: (a: WorkspaceAction) => void;
  onOpenUrl: (url: string) => void;
  onShow: (paneId: PaneId) => void;
  /** Starts with this filter (stories). */
  initialQuery?: string;
}

export function Actions(p: ActionsProps) {
  const { list } = p;
  const [query, setQuery] = useState(p.initialQuery ?? "");
  const runs = useMemo(() => new Map((list?.runs ?? []).map((r) => [r.actionId, r])), [list]);

  const row = (a: WorkspaceAction, big = false) => {
    const r = runs.get(a.id);
    const on = running(r);
    // Running in another worktree of this repository (another agent's checkout).
    const away = on ? [] : (list?.elsewhere ?? []).filter((x) => x.actionId === a.id && x.endedAt === null);
    const bad = failed(r);
    const url = r?.url ?? null;
    const state =
      on ? durationText(p.now - r!.startedAt)
      : bad ? `exit ${r!.exitCode}`
      : r && r.endedAt !== null && r.exitCode === 0 ? durationText(r.endedAt - r.startedAt)
      : null;
    return (
      <ListRow
        key={a.id}
        flipKey={a.id}
        icon={a.history ? "clock.arrow.circlepath" : a.source.kind === "readme" ? "doc.text" : KIND[a.kind].icon}
        light={on ? "working" : bad ? "danger" : undefined}
        title={a.name}
        mono
        detail={a.description ? a.description : a.history ? `${a.history.runs}× in this folder` : a.command}
        tone={bad ? "danger" : undefined}
        tip={`${a.command}${a.script && a.script !== a.command ? `\n→ ${a.script}` : ""}\n${a.source.kind === "history" ? "From your history" : a.source.kind === "readme" ? "Suggested from the docs" : `${a.source.file}${a.source.line ? `:${a.source.line}` : ""}`}${a.risky ? "\nAsks before it runs" : ""}`}
        end={
          <>
            {url && (
              <LinkButton tone="accent" onClick={(e) => (e.stopPropagation(), p.onOpenUrl(url))} data-tip={`Open ${url}`}>
                {shortUrl(url)}
              </LinkButton>
            )}
            {state && <ListValue>{state}</ListValue>}
            {away.map((x) => (
              <LinkButton key={x.paneId} tone="dim" onClick={(e) => (e.stopPropagation(), p.onShow(x.paneId))} data-tip={`Running in ${shortPath(x.root)}${x.url ? ` at ${x.url}` : ""}. Show its terminal`}>
                in {x.branch ?? x.root.split("/").pop()}
                {x.url ? ` · ${shortUrl(x.url)}` : ""}
              </LinkButton>
            ))}
            {big && !on && (
              <Button size="sm" variant="primary" icon="play.fill" onClick={(e) => (e.stopPropagation(), p.onRun(a))}>
                Run
              </Button>
            )}
          </>
        }
        hover={
          on ? (
            <>
              {a.long && <IconButton size="sm" icon="arrow.clockwise" label="Restart" onClick={() => p.onRun(a, { restart: true })} />}
              <IconButton size="sm" icon="stop.fill" label="Stop" onClick={() => p.onStop(a)} />
            </>
          ) : big ? undefined : (
            <IconButton size="sm" icon={a.args ? "text.cursor" : "play.fill"} label={a.args ? "Type in Terminal" : "Run"} onClick={() => p.onRun(a)} />
          )
        }
        onClick={() => (on ? p.onShow(r!.paneId) : p.onRun(a))}
        onContextMenu={() => p.onMenu(a)}
      />
    );
  };

  const section = (key: string, title: string, rows: WorkspaceAction[], closed = false) => {
    if (!rows.length) return null;
    const open = closed ? p.toggled.has(key) : !p.toggled.has(key);
    return (
      <ListSection key={key} title={title} count={rows.length} open={open} onToggle={() => p.onToggle(key)}>
        {rows.map((a) => row(a))}
      </ListSection>
    );
  };

  const all = list ? [...list.actions, ...list.history, ...list.suggested] : [];
  const q = query.trim().toLowerCase();
  const matches = q ? all.filter((a) => [a.name, a.command, a.description ?? "", a.package ?? ""].some((t) => t.toLowerCase().includes(q))) : [];
  const state: ViewStateSpec | null =
    !p.root ? { kind: "empty", icon: "play.rectangle", title: "No folder", text: "This workspace has no folder." }
    : !list ? (p.error ? { kind: "error", title: "Can't read this folder", text: p.error } : { kind: "loading" })
    : all.length === 0 ? { kind: "empty", icon: "play.rectangle", title: "No scripts here", text: `Nothing to run in ${shortPath(list.root)} yet. Scripts in package.json, a Makefile, a justfile and similar files show up here.` }
    : q && !matches.length ? { kind: "noResults", title: "No matches", text: `Nothing here is called “${query}”.`, action: <Button onClick={() => setQuery("")}>Clear Filter</Button> }
    : null;

  const runCount = (list?.runs ?? []).filter((r) => r.endedAt === null).length;
  const failCount = (list?.runs ?? []).filter(failed).length;
  const footer = list && all.length > 0 && (
    <StatusLine
      end={
        p.showWhere && list.checkout ? (
          <span data-tip={`Actions of ${shortPath(list.root)}: they run there`}>
            <Icon name="arrow.triangle.branch" size={11} /> {list.checkout.branch ?? "detached"} · {shortPath(list.root)}
          </span>
        ) : undefined
      }
    >
      {list.describing ? (
        <>
          <Spinner size={10} /> Describing actions…
        </>
      ) : p.offerAi ? (
        <>
          <LinkButton onClick={p.onSetUpAi}>Set up AI</LinkButton> to see what each action does.
        </>
      ) : (
        <>
          {all.length} actions{runCount ? ` · ${runCount} running` : ""}
          {failCount ? ` · ${failCount} failed` : ""}
        </>
      )}
    </StatusLine>
  );

  let body = null;
  if (list && !state) {
    const primary = q ? undefined : list.actions.find((a) => a.id === list.primary);
    const rest = list.actions.filter((a) => a !== primary);
    const rootRows = rest.filter((a) => !a.package && !a.hidden && !a.pinned);
    const packages = [...new Set(rest.filter((a) => a.package && !a.hidden && !a.pinned).map((a) => a.package!))];
    const hidden = rest.filter((a) => a.hidden && !a.pinned);
    body = (
      <List variant="grouped">
        {list.sources
          .filter((x) => x.error)
          .map((e) => (
            <Callout key={e.file} tone="danger" title={`${e.file} can't be read`}>
              {e.error} Showing what it had before.
            </Callout>
          ))}
        {q ? (
          <ListSection title="Matches" count={matches.length}>
            {matches.map((a) => row(a))}
          </ListSection>
        ) : (
          <>
            {/* The main action (usually dev), on its own above the sections: the title bar already names the folder. */}
            {primary && <ListGroup>{row(primary, true)}</ListGroup>}
            {section("pinned", "Pinned", rest.filter((a) => a.pinned))}
            {ORDER.filter((k) => k !== "agent").map((k) => section(`kind:${k}`, KIND[k].title, rootRows.filter((a) => a.kind === k)))}
            {[...new Set(rootRows.filter((a) => a.kind === "agent").map((a) => a.agent ?? ""))].map((ag) => section(`agent:${ag}`, `${AGENT_TITLE[ag] ?? "Agent"} Skills`, rootRows.filter((a) => a.kind === "agent" && (a.agent ?? "") === ag)))}
            {packages.map((pk) => section(`pkg:${pk}`, pk, rest.filter((a) => a.package === pk && !a.hidden && !a.pinned), true))}
            {section("history", "From Your History", list.history)}
            {section("suggested", "Suggested", list.suggested)}
            {section("hidden", "More", hidden, true)}
          </>
        )}
      </List>
    );
  }

  return (
    <View
      inset
      state={state}
      toolbar={
        all.length > 12 && (
          <WindowToolbar label="Actions">
            <ToolbarSearchField value={query} onChange={setQuery} placeholder="Filter actions" count={q ? String(matches.length) : undefined} minWidth={90} onKeyDown={(k) => k.key === "Enter" && matches[0] && p.onRun(matches[0])} />
          </WindowToolbar>
        )
      }
      footer={footer}
    >
      {body}
    </View>
  );
}

export function ActionsView({ win }: WindowViewProps) {
  const s = useStore();
  const root = actionsRootOf(win);
  const { list, error } = useActions(root);
  useEffect(() => {
    if (list) lastLists.set(win.id, list);
  }, [list, win.id]);
  useEffect(() => () => void lastLists.delete(win.id), [win.id]);
  const ai = useAiStatus();
  const [confirm, setConfirm] = useState<{ a: WorkspaceAction; restart?: boolean } | null>(null);
  const toggled = useMemo(() => new Set(Array.isArray(win.state.toggled) ? (win.state.toggled as string[]) : []), [win.state.toggled]);
  const runs = useMemo(() => new Map((list?.runs ?? []).map((r) => [r.actionId, r])), [list]);
  const [now, setNow] = useState(Date.now());
  const anyRunning = (list?.runs ?? []).some((r) => r.endedAt === null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), anyRunning ? 1000 : 15_000);
    return () => clearInterval(t);
  }, [anyRunning]);

  const runningCount = (list?.runs ?? []).filter((r) => r.endedAt === null).length;
  const failedCount = (list?.runs ?? []).filter(failed).length;
  useWidgetStatus(win.id, runningCount ? `${runningCount} running` : failedCount ? `${failedCount} failed` : null);

  const workspaceId: WorkspaceId = win.workspaceId;
  const run = useCallback(
    async (a: WorkspaceAction, o: { restart?: boolean; fresh?: boolean; confirmed?: boolean } = {}) => {
      if (!list) return;
      if (a.risky && !a.args && !o.confirmed) return setConfirm({ a, restart: o.restart });
      await runAction(list.root, a, workspaceId, o).catch(() => {});
    },
    [list, workspaceId],
  );
  const stop = (a: WorkspaceAction) => list && void cmd.call("actions.stop", { root: list.root, actionId: a.id }).catch(() => {});
  const pin = (a: WorkspaceAction) => list && void cmd.call("actions.pin", { root: list.root, actionId: a.id, pinned: !a.pinned }).catch(() => {});
  const openUrl = (url: string) => (s.settings.settings["open.links"] === "browser" ? openLink(url) : void newBrowser(url));

  const rowMenu = (a: WorkspaceAction) => {
    const r = runs.get(a.id);
    const on = running(r);
    void showContextMenu([
      { label: on ? "Show Terminal" : a.args ? "Type in Terminal" : "Run", run: () => (on ? goTo(r!.paneId, workspaceId) : void run(a)) },
      { label: "Run in New Terminal", enabled: !a.args, run: () => void run(a, { fresh: true }) },
      ...(on ? [{ label: "Restart", run: () => void run(a, { restart: true }) }, { label: "Stop", run: () => stop(a) }] : []),
      ...(r && !on && s.panes.has(r.paneId) ? [{ label: "Show Terminal", run: () => goTo(r.paneId, workspaceId) }] : []),
      ...(r?.url || a.url ? [{ label: `Open ${shortUrl((r?.url ?? a.url)!)}`, run: () => openUrl((r?.url ?? a.url)!) }] : []),
      ...(list?.elsewhere ?? []).filter((x) => x.actionId === a.id && x.endedAt === null).map((x) => ({ label: `Show It in ${x.branch ?? x.root.split("/").pop()}`, run: () => goTo(x.paneId, workspaceId) })),
      "-",
      { label: a.pinned ? "Unpin" : "Pin to Top", run: () => pin(a) },
      { label: "Copy Command", run: () => copy(a.command) },
      ...(a.source.kind !== "history" && a.source.kind !== "readme" && list ? [{ label: `Open ${a.source.file}`, run: () => void openFileAt(`${list.root}/${a.source.file}`, a.source.line ?? 1, null, null) }] : []),
    ]);
  };

  const describedNone = !!list && list.actions.every((a) => !a.description);
  return (
    <>
      <Actions
        root={root}
        list={list}
        error={error}
        now={now}
        toggled={toggled}
        onToggle={(key) => setWidgetState(win.id, { toggled: toggled.has(key) ? [...toggled].filter((k) => k !== key) : [...toggled, key] })}
        showWhere={!!list?.checkout && (list.checkout.linked || list.root !== s.workspaces.get(win.workspaceId)?.root)}
        offerAi={!!ai && !ai.ready && !!s.settings.settings["actions.describe"] && describedNone}
        onSetUpAi={() => cmd.openSettings("ai")}
        onRun={(a, o) => void run(a, o)}
        onStop={stop}
        onMenu={rowMenu}
        onOpenUrl={openUrl}
        onShow={(paneId) => goTo(paneId, workspaceId)}
      />
      <ConfirmDialog
        open={!!confirm}
        title={`Run “${confirm?.a.name}”?`}
        confirm="Run"
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          if (c) void run(c.a, { restart: c.restart, confirmed: true });
        }}
      >
        {confirm?.a.description && <p>{confirm.a.description}.</p>}
        <CodeBlock>{confirm?.a.command ?? ""}</CodeBlock>
      </ConfirmDialog>
    </>
  );
}
