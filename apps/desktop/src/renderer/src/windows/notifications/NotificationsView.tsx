// Notifications, a built-in widget (docs/16-widgets.md): the notifications cmd
// sent since the last Clear (core/src/notifications/center.ts), shown or not, so one
// missed while away is still here: a live query over notification events. Of
// this workspace's terminals and windows (the workspace recorded when it was sent), or
// every workspace's; those about nothing in particular show in every workspace. A click
// goes to the terminal or window it is about.

import { EmptyState, List, ListRow, ListRowContent, ListRowEnd, ListRowIcon, ListSection, ListValue, Panel, PanelBody, type IconName } from "@cmd/ui";
import { useEffect, useMemo, useState } from "react";
import { notificationOf, type AppNotification } from "@cmd/protocol";
import { copy } from "../../lib/actions.ts";
import { showContextMenu } from "../../lib/context.ts";
import { subscribeData, useStore } from "../../lib/store.ts";
import { goTo, scopeOf } from "../../lib/widgets.ts";
import type { WindowViewProps } from "../registry.ts";
import { shortAgo } from "../../components/SidebarRows.tsx";

const ICONS: Record<AppNotification["source"], IconName> = {
  "agent-input": "user-circle-dashed",
  "agent-done": "user-circle-check",
  bell: "bell",
  terminal: "terminal-window",
  command: "terminal-window",
  cli: "bell",
  widget: "sparkle",
  summary: "file-text",
  timer: "timer",
};

const MAX = 200;

/** Since the last Clear, newest first: a live query over notification events and Clear markers. */
function useNotifications(): AppNotification[] {
  const [list, setList] = useState<AppNotification[]>([]);
  useEffect(() => {
    let cleared = 0;
    let have: AppNotification[] = [];
    // The newest Clear on its own: the list below may be all notifications and not reach back to it.
    const offClear = subscribeData({ types: ["notification.clear"], by: "time", order: "desc", limit: 1 }, (events) => {
      cleared = Math.max(cleared, ...events.map((e) => e.at));
      setList((have = have.filter((n) => n.at > cleared)));
    });
    const off = subscribeData({ types: ["notification"], by: "time", order: "desc", limit: MAX }, (events, initial) => {
      const incoming = events.map(notificationOf).filter((n) => n.at > cleared);
      const base = initial ? [] : have;
      have = [...incoming, ...base.filter((n) => !incoming.some((x) => x.id === n.id))].sort((a, b) => b.at - a.at).slice(0, MAX);
      setList(have);
    });
    return () => (off(), offClear());
  }, []);
  return list;
}

const startOfToday = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime();

export function NotificationsView({ win }: WindowViewProps) {
  const s = useStore();
  const all = useNotifications();
  // New ones arrive at the top: the rest glide down, the new one fades in.
  const scope = scopeOf(win.state.scope);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /** The workspace of what it is about: where it is now, else where it was when sent; undefined: nothing in particular. */
  const workspaceOf = (n: AppNotification) => (n.paneId ? s.panes.get(n.paneId)?.workspaceId : n.windowId ? s.windows.get(n.windowId)?.workspaceId : undefined) ?? n.workspaceId ?? undefined;
  const shown = useMemo(() => all.filter((n) => scope === "all" || (workspaceOf(n) ?? win.workspaceId) === win.workspaceId), [all, scope, win.workspaceId, s.panes, s.windows]);
  const today = startOfToday();
  const groups = [
    { title: "Today", items: shown.filter((n) => n.at >= today) },
    { title: "Earlier", items: shown.filter((n) => n.at < today) },
  ].filter((g) => g.items.length > 0);

  const target = (n: AppNotification) => {
    const id = n.paneId ?? n.windowId ?? null;
    return id && (s.panes.has(id) || s.windows.has(id)) ? id : null;
  };
  const open = (n: AppNotification) => {
    const id = target(n);
    if (id) goTo(id, workspaceOf(n));
  };
  const rowMenu = (n: AppNotification) =>
    void showContextMenu([
      { label: n.paneId ? "Show Terminal" : "Show Window", enabled: !!target(n), run: () => open(n) },
      { label: "Copy Text", run: () => copy(`${n.title}\n${n.body}`) },
    ]);

  return (
    <Panel>
      <PanelBody>
        <List>
          {groups.map((g) => (
            <ListSection key={g.title} title={g.title} count={g.items.length}>
              {g.items.map((n) => (
                <ListRow
                  key={n.id}
                  flipKey={n.id}
                  tip={n.body.length > 60 ? n.body : undefined}
                  onClick={() => open(n)}
                  onContextMenu={() => rowMenu(n)}
                >
                  <ListRowIcon icon={ICONS[n.source] ?? "bell"} />
                  <ListRowContent title={n.title} detail={n.body || " "} tone={n.urgent && n.source !== "timer" ? "needs" : undefined} />
                  <ListRowEnd>
                    <ListValue>{n.at >= today ? new Date(n.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : shortAgo(n.at, now)}</ListValue>
                  </ListRowEnd>
                </ListRow>
              ))}
            </ListSection>
          ))}
        </List>
        {shown.length === 0 && (
          <EmptyState compact icon="bell" title="No notifications">
            When an agent needs you or a long command finishes, it shows up here, even if you missed it.
          </EmptyState>
        )}
      </PanelBody>
    </Panel>
  );
}
