// Now: what needs you, what's working, what just finished, across workspaces or in
// one. A row opens its terminal. With control access, a bar at the bottom
// starts a terminal or a Claude session in the workspace shown, and jumps to the
// oldest thing that needs you.

import { useMemo, useState } from "react";
import { Badge, Button, EmptyState, ListRow, ListRowContent, ListRowEnd, ListRowIcon, ListSection } from "@cmd/ui";
import type { Connection } from "./connection.ts";
import { sections, workspaceList, type Item, type Model } from "./model.ts";
import { ago } from "./ui.tsx";

export function Now({ conn, model, workspaceId, onWorkspace, onOpen }: { conn: Connection; model: Model; workspaceId: string | null; onWorkspace: (id: string | null) => void; onOpen: (paneId: string) => void }) {
  const groups = useMemo(() => sections(model, workspaceId), [model, workspaceId]);
  const workspaces = useMemo(() => workspaceList(model), [model]);
  const needs = groups.find((g) => g.group === "needs")?.items ?? [];
  const control = model.scope === "control";
  const [busy, setBusy] = useState(false);
  const workspaceName = (id: string | null) => (id ? model.workspaces.get(id)?.name : null) ?? "Home";

  const start = async (what: "terminal" | "claude") => {
    if (busy || !conn.client) return;
    setBusy(true);
    try {
      const target = workspaceId ?? undefined;
      const paneId = what === "terminal" ? (await conn.client.call("pane.create", { workspaceId: target })).id : (await conn.client.call("agent.spawn", { kind: "claude", workspaceId: target })).paneId;
      if (paneId) onOpen(paneId);
    } catch {
      // stays on Now; the Mac's log has why
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {workspaces.length > 1 && (
        <nav className="filters" aria-label="Workspaces">
          <Button size="sm" pressed={workspaceId === null} onClick={() => onWorkspace(null)}>
            All
          </Button>
          {workspaces.map(({ workspace, needs }) => (
            <Button key={workspace.id} size="sm" pressed={workspaceId === workspace.id} onClick={() => onWorkspace(workspace.id)} trailing={needs > 0 ? <Badge tone="warning" solid size="sm">{needs}</Badge> : undefined}>
              {workspace.name}
            </Button>
          ))}
        </nav>
      )}
      <main className="now">
        {groups.length === 0 ? (
          <EmptyState icon="terminal-window" title={`Nothing running${workspaceId ? ` in ${workspaceName(workspaceId)}` : ""}`}>
            {control ? "Start a terminal or a Claude session below." : null}
          </EmptyState>
        ) : (
          groups.map((g) => (
            <ListSection key={g.group} title={g.title} count={g.items.length} tone={g.group === "needs" ? "needs" : undefined}>
              {g.items.map((it) => (
                <Row key={it.paneId} it={it} showWorkspace={workspaceId === null && workspaces.length > 1} onOpen={onOpen} />
              ))}
            </ListSection>
          ))
        )}
      </main>
      {(control || needs.length > 0) && (
        <footer className="actions">
          {needs.length > 0 && (
            <Button size="lg" variant="primary" icon="lightning" onClick={() => onOpen(needs[0]!.paneId)}>
              Next
            </Button>
          )}
          {control && (
            <>
              <Button size="lg" icon="terminal-window" disabled={busy} onClick={() => void start("terminal")}>
                Terminal
              </Button>
              <Button size="lg" icon="sparkle" disabled={busy} onClick={() => void start("claude")}>
                Claude
              </Button>
            </>
          )}
        </footer>
      )}
    </>
  );
}

function Row({ it, showWorkspace, onOpen }: { it: Item; showWorkspace: boolean; onOpen: (paneId: string) => void }) {
  const place = showWorkspace && it.workspace ? it.workspace : null;
  return (
    <ListRow
      role="button"
      tabIndex={0}
      data-group={it.group}
      onClick={() => onOpen(it.paneId)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(it.paneId)}
    >
      <ListRowIcon icon={it.agent ? "sparkle" : "terminal-window"} light={it.light === "idle" ? undefined : it.light} />
      <ListRowContent title={it.title} place={place} detail={it.detail ? (place ? `${place} · ${it.detail}` : it.detail) : undefined} tone={it.group === "needs" ? "needs" : undefined} />
      <ListRowEnd><span className="when">{ago(it.since)}</span></ListRowEnd>
    </ListRow>
  );
}
