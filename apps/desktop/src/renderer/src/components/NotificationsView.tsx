// Notifications, a built-in widget (docs/16-widgets.md): the notifications cmd
// sent since the last Clear (core/notifications.ts), shown or not, so one
// missed while away is still here: a live query over notification events. Of
// this workspace's terminals and windows (the workspace recorded when it was sent), or
// every workspace's; those about nothing in particular show in every workspace. A click
// goes to the terminal or window it is about.

import { EmptyState, ListRow, ListSection, ListValue, Panel, PanelBody, useFlip } from "@cmd/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { notificationOf, type AppNotification } from "@cmd/protocol";
import { copy } from "../actions.ts";
import { showContextMenu } from "../context.ts";
import { subscribeData, useStore } from "../store.ts";
import { goTo, scopeOf } from "../widgets.ts";
import type { WindowViewProps } from "../windows/registry.ts";
import { shortAgo } from "./SidebarRows.tsx";

const ICONS: Record<AppNotification["source"], string> = {
  "agent-input": "person.crop.circle.badge.questionmark",
  "agent-done": "person.crop.circle.badge.checkmark",
  bell: "bell",
  terminal: "terminal",
  command: "terminal",
  cli: "bell",
  widget: "sparkles",
  summary: "doc.text",
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
  const listRef = useRef<HTMLDivElement>(null);
  useFlip(listRef, { selector: "[data-key]" });
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
        <div ref={listRef}>
        {groups.map((g) => (
          <ListSection key={g.title} title={g.title} count={g.items.length}>
            {g.items.map((n) => (
              <ListRow
                key={n.id}
                flipKey={n.id}
                icon={ICONS[n.source] ?? "bell"}
                title={n.title}
                detail={n.body || " "}
                tone={n.urgent && n.source !== "timer" ? "needs" : undefined}
                tip={n.body.length > 60 ? n.body : undefined}
                end={<ListValue>{n.at >= today ? new Date(n.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : shortAgo(n.at, now)}</ListValue>}
                onClick={() => open(n)}
                onContextMenu={() => rowMenu(n)}
              />
            ))}
          </ListSection>
        ))}
        {shown.length === 0 && (
          <EmptyState compact icon="bell" title="No notifications">
            When an agent needs you or a long command finishes, it shows up here, even if you missed it.
          </EmptyState>
        )}
        </div>
      </PanelBody>
    </Panel>
  );
}
