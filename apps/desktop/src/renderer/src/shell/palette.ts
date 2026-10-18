// What the command palette lists: the commands that apply now (with their shortcuts), the
// workspace's Workspace Actions, its open windows; and ?search (docs/33): the workspace's
// files (live from disk), past agent sessions, commands and what they printed, pages and files
// opened in cmd. Item builders are plain functions over a command context, so a test can build them.

import { useEffect, useState } from "react";
import type { ActionsList } from "@cmd/protocol";
import { COMMANDS, prettyAccelerator, type CommandSpec, type Keybindings } from "../../../shared/commands.ts";
import { contextCwd, newTerminalIn, openFileAt, openLink, openPath, openSession } from "../lib/actions.ts";
import { cmd } from "../lib/bridge.ts";
import { ago, fieldsOf, shortPath, windowIdOf } from "../lib/model.ts";
import { select } from "../lib/selection.ts";
import { getState } from "../lib/store.ts";
import { listActions, runAction } from "../windows/actions/workspaceActions.ts";
import { applies, runCommand, type CommandContext } from "./commands/registry.ts";
import { LINE_PREFIX, type PaletteItem } from "./Palette.tsx";

/** What the palette's search matches besides past sessions: what's open. */
export const SEARCH_GROUPS = ["Sessions"];

/** The commands that apply in `c`, as palette items (not the hidden ones, nor the palette itself). */
export function commandItems(c: CommandContext, bindings: Keybindings): PaletteItem[] {
  return (COMMANDS as readonly CommandSpec[])
    .filter((x) => !x.paletteHidden && x.id !== "view.palette" && applies(x.id, c))
    .map((x) => ({ id: x.id, group: "Commands", label: x.label.replace(/…$/, ""), hint: prettyAccelerator(bindings[x.id]?.[0]), run: () => runCommand(x.id, "palette") }));
}

/** The workspace's Workspace Actions; risky ones (deploys) are left to the widget, which asks first. */
export function actionItems(list: ActionsList | null, c: CommandContext): PaletteItem[] {
  if (!list || list.root !== c.workspace?.root) return [];
  return [...list.actions.filter((a) => !a.hidden), ...list.history]
    .filter((a) => !a.risky)
    .map((a) => ({
      id: `a-${a.id}`,
      group: "Actions",
      icon: "play",
      label: a.package ? `${a.name} (${a.package})` : a.name,
      meta: a.description ?? a.command,
      run: () => void runAction(list.root, a, c.state.workspaceId).catch(() => {}),
    }));
}

/** The board's open windows. */
export function windowItems(c: CommandContext): PaletteItem[] {
  return c.board.windows.map((r) => {
    const f = fieldsOf(r, undefined, Date.now());
    return { id: `s-${r.key}`, group: "Sessions", label: f.place ? `${f.name} — ${f.place}` : f.name, run: () => select(windowIdOf(r)!) };
  });
}

/** The workspace's Workspace Actions, read when the palette opens (its Actions group). */
export function usePaletteActions(open: boolean): ActionsList | null {
  const [list, setList] = useState<ActionsList | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void listActions(getState().workspaceId).then((l) => live && setList(l));
    return () => void (live = false);
  }, [open]);
  return list;
}

/**
 * ?query: each source shows as soon as it answers, always in this order: file names come
 * from a cached list, lines from reading the files, history and sessions from the index.
 * Open windows come from the palette's own items (SEARCH_GROUPS).
 */
export async function searchAll(text: string, show: (items: PaletteItem[]) => void): Promise<PaletteItem[]> {
  const st = getState();
  const workspace = st.workspaces.get(st.workspaceId);
  const now = Date.now();
  const cwd = contextCwd() ?? null;
  const meta = (...parts: (string | number | null | false | undefined)[]) => parts.filter(Boolean).join(" · ");
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const dirIn = (p: string, root: string) => {
    const rel = p.startsWith(root + "/") ? p.slice(root.length + 1) : shortPath(p);
    return rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : base(root);
  };
  const parts: { names: PaletteItem[]; lines: PaletteItem[]; sessions: PaletteItem[]; history: PaletteItem[] } = { names: [], lines: [], sessions: [], history: [] };
  const named = new Set<string>();
  // A file found by its name isn't listed again among the files opened in cmd.
  const all = () => [...parts.names, ...parts.lines, ...parts.sessions, ...parts.history.filter((it) => !(it.id.startsWith("o-") && named.has(it.id.slice(2))))];
  const part = <T,>(key: keyof typeof parts, p: Promise<T>, map: (r: T) => PaletteItem[]) =>
    p.then(
      (r) => ((parts[key] = map(r)), show(all())),
      () => {},
    );
  await Promise.all([
    part("names", cmd.call("search.files", { text, workspaceId: st.workspaceId, cwd, limit: 8, part: "names" }), (r) =>
      r.hits.map((h) => (named.add(h.path), { id: `f-${h.path}`, group: "Files", icon: "file", label: base(h.path), meta: dirIn(h.path, h.root), run: () => void openPath(h.path, "user") })),
    ),
    part("lines", cmd.call("search.files", { text, workspaceId: st.workspaceId, cwd, limit: 20, part: "lines" }), (r) =>
      r.hits.map((h) => ({ id: `l-${h.path}:${h.line}`, group: "Files", icon: "text-align-left", label: `${base(h.path)}:${h.line}`, meta: dirIn(h.path, h.root), snippet: h.text, run: () => void openFileAt(h.path, h.line!, h.column, text.trim()) })),
    ),
    part("sessions", cmd.call("search.query", { text, limit: 8 }), (hits) =>
      hits.map((h) => ({
        id: `h-${h.agent}-${h.sessionId}`,
        group: "Past sessions",
        icon: "clock-counter-clockwise",
        label: h.title || "(untitled session)",
        meta: meta(h.agent, h.cwd && shortPath(h.cwd), h.branch, h.updatedAt && ago(h.updatedAt, now), h.fuzzy && "~"),
        snippet: h.snippet,
        run: () => void openSession(h),
      })),
    ),
    // Home holds what happened anywhere; another workspace what happened in it.
    part("history", cmd.call("search.history", { text, workspaceId: workspace?.home ? null : st.workspaceId, limit: 5 }), (hits) =>
      hits.flatMap((h): PaletteItem[] => {
        if (h.kind === "command")
          return [{
            id: `c-${h.command}-${h.cwd}`,
            group: "Commands",
            icon: "terminal-window",
            label: h.command,
            meta: meta(h.cwd && shortPath(h.cwd), h.exitCode ? `exit ${h.exitCode}` : null, h.runs > 1 && `${h.runs}×`, ago(h.at, now)),
            snippet: h.snippet,
            // Its terminal if that is still open, else a new one in its folder.
            run: () => (h.paneId && getState().panes.has(h.paneId) ? select(h.paneId) : void newTerminalIn(h.cwd ?? "~")),
          }];
        if (h.kind === "page") {
          const host = /^https?:\/\/([^/]+)/.exec(h.url)?.[1] ?? h.url;
          return [{ id: `p-${h.url}`, group: "Pages", icon: "globe", label: h.title || h.url, meta: meta(host, ago(h.at, now)), run: () => openLink(h.url) }];
        }
        return [{ id: `o-${h.path}`, group: "Opened files", icon: "file", label: base(h.path), meta: meta(shortPath(h.path.slice(0, h.path.lastIndexOf("/"))), ago(h.at, now)), run: () => void openPath(h.path, "user") }];
      }),
    ),
  ]);
  return all();
}

/** Go to Line: `:` and a number, in the selected window's editor (⌃G opens the palette with the `:`). */
export function lineItems(query: string, c: CommandContext): PaletteItem[] {
  const text = c.actions?.text;
  if (!text || !query.startsWith(LINE_PREFIX)) return [];
  const lines = text.lines();
  const m = /^:\s*(\d+)(?::(\d+))?\s*$/.exec(query);
  if (!m) return [{ id: "text.line", group: "Go to Line", label: `Type a line number, 1 to ${lines}`, icon: "arrow-line-right", run: () => {} }];
  const line = Math.min(Math.max(1, Number(m[1])), lines);
  const column = m[2] ? Math.max(1, Number(m[2])) : undefined;
  return [{ id: "text.line", group: "Go to Line", label: column ? `Go to line ${line}, column ${column}` : `Go to line ${line}`, icon: "arrow-line-right", run: () => text.goToLine(line, column) }];
}
