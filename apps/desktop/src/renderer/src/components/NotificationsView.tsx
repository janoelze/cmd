// Notifications, a built-in widget (docs/16-widgets.md): the notifications cmd
// sent since it started (core/notifications.ts, notify.list), shown or not, so
// one missed while away is still here. Of this Space's terminals and windows,
// or every Space's; those about nothing in particular show in every Space. A
// click goes to the terminal or window it is about.

import { EmptyState, ListRow, ListSection, ListValue, Panel, PanelBody } from "@cmd/ui";
import { useEffect, useMemo, useState } from "react";
import type { AppNotification } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { copy } from "../actions.ts";
import { showContextMenu } from "../context.ts";
import { onNotification, onNotificationsCleared, useStore } from "../store.ts";
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

/** The log, newest first, kept current from notification events. */
function useNotifications(): AppNotification[] {
  const [list, setList] = useState<AppNotification[]>([]);
  useEffect(() => {
    let stale = false;
    const off = onNotification((n) => setList((l) => [n, ...l.filter((x) => x.id !== n.id)].slice(0, 200)));
    const offCleared = onNotificationsCleared(() => setList([]));
    cmd.call("notify.list", {}).then(
      (got) => !stale && setList((l) => [...l.filter((x) => !got.some((g) => g.id === x.id)), ...got].sort((a, b) => b.at - a.at)),
      () => {}, // an older core
    );
    return () => ((stale = true), off(), offCleared());
  }, []);
  return list;
}

const startOfToday = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime();

export function NotificationsView({ win }: WindowViewProps) {
  const s = useStore();
  const all = useNotifications();
  const scope = scopeOf(win.state.scope);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /** The Space of what it is about; undefined: nothing in particular. */
  const spaceOf = (n: AppNotification) => (n.paneId ? s.panes.get(n.paneId)?.spaceId : n.windowId ? s.windows.get(n.windowId)?.spaceId : undefined);
  const shown = useMemo(() => all.filter((n) => scope === "all" || (spaceOf(n) ?? win.spaceId) === win.spaceId), [all, scope, win.spaceId, s.panes, s.windows]);
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
    if (id) goTo(id, spaceOf(n));
  };
  const rowMenu = (n: AppNotification) =>
    void showContextMenu([
      { label: n.paneId ? "Show Terminal" : "Show Window", enabled: !!target(n), run: () => open(n) },
      { label: "Copy Text", run: () => copy(`${n.title}\n${n.body}`) },
    ]);

  return (
    <Panel>
      <PanelBody>
        {groups.map((g) => (
          <ListSection key={g.title} title={g.title} count={g.items.length}>
            {g.items.map((n) => (
              <ListRow
                key={n.id}
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
      </PanelBody>
    </Panel>
  );
}
