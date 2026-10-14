// __TITLE__: the terminals of this workspace, the ones running a command first. A search
// field and a choice in the toolbar filter them, a click selects the terminal's window,
// and the title bar says how many are busy. Start here: change what it shows, save, and
// the window on the board follows (cmd widget dev).

import { Window, View, WindowToolbar, ToolbarSearchField, ToolbarSegmented, List, ListRow, ListRowIcon, ListRowContent, ListRowEnd, Chip, useTerminals, useConfig, useStoredState, cmd, type Terminal, type ViewState } from "@cmd/widget-api";

export type Show = "all" | "busy";

/** A folder's last part: "/Users/me/src/app" is "app". */
export const folderOf = (cwd: string): string => cwd.split("/").filter(Boolean).pop() ?? "/";

/** The terminals to list: those matching the filter text (title, folder or command), busy ones first, then by title. */
export function visible(terminals: Terminal[], query: string, show: Show): Terminal[] {
  const q = query.trim().toLowerCase();
  return terminals
    .filter((t) => show === "all" || t.command)
    .filter((t) => !q || [t.title, t.cwd, t.command ?? ""].some((s) => s.toLowerCase().includes(q)))
    .sort((a, b) => Number(!!b.command) - Number(!!a.command) || a.title.localeCompare(b.title));
}

export default function Terminals() {
  const terminals = useTerminals();
  const { showFolders } = useConfig(); // typed from package.json's config (cmd-env.d.ts)
  const [show, setShow] = useStoredState<Show>("show", "all"); // kept per window, across restarts
  const [query, setQuery] = useStoredState<string>("query", "");
  const list = visible(terminals, query, show);
  const busy = terminals.filter((t) => t.command).length;
  const showAll = () => {
    setQuery("");
    setShow("all");
  };

  const state: ViewState | null = !terminals.length
    ? { icon: "terminal", title: "No terminals here", text: "Open one with ⌘T." }
    : !list.length
      ? { kind: "noResults", icon: "magnifyingglass", title: "No matches", action: { label: "Show All", run: showAll } }
      : null;

  return (
    <Window status={busy ? `${busy} running` : null}>
      <View state={state}>
        <WindowToolbar label="Filter terminals">
          <ToolbarSegmented
            label="Show"
            value={show}
            options={[
              { value: "all", label: "All" },
              { value: "busy", label: "Running" },
            ]}
            onChange={(v) => setShow(v as Show)}
          />
          <ToolbarSearchField value={query} placeholder="Filter" count={query ? `${list.length} of ${terminals.length}` : undefined} onChange={setQuery} />
        </WindowToolbar>
        <List>
          {list.map((t) => (
            <ListRow key={t.id} onClick={() => t.windowId && void cmd.windows.select(t.windowId).catch(() => {})}>
              <ListRowIcon icon={t.agentId ? "sparkle" : "terminal"} tone={t.command ? undefined : "dim"} />
              <ListRowContent title={t.title} place={showFolders ? folderOf(t.cwd) : undefined} />
              <ListRowEnd>{t.command ? <Chip>{t.command}</Chip> : null}</ListRowEnd>
            </ListRow>
          ))}
        </List>
      </View>
    </Window>
  );
}
