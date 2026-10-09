// Now: what needs you, what's working, what just finished, across workspaces or in
// one. A row opens its terminal. With control access, a bar at the bottom
// starts a terminal or a Claude session in the workspace shown, and jumps to the
// oldest thing that needs you.

import { useMemo, useState } from "react";
import type { Connection } from "./connection.ts";
import { sections, workspaceList, type Item, type Model } from "./model.ts";
import { ago, Icon, Led } from "./ui.tsx";

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
        <nav className="chips">
          <button className={`chip${workspaceId === null ? " on" : ""}`} onClick={() => onWorkspace(null)}>
            All
          </button>
          {workspaces.map(({ workspace, needs }) => (
            <button key={workspace.id} className={`chip${workspaceId === workspace.id ? " on" : ""}`} onClick={() => onWorkspace(workspace.id)}>
              {workspace.name}
              {needs > 0 && <span className="chip-badge">{needs}</span>}
            </button>
          ))}
        </nav>
      )}
      <main className="now">
        {groups.length === 0 ? (
          <div className="empty">
            <Icon name="terminal" size={28} />
            <div>Nothing running{workspaceId ? ` in ${workspaceName(workspaceId)}` : ""}.</div>
            {control && <div className="dim">Start a terminal or a Claude session below.</div>}
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.group}>
              <h2>
                {g.title} <span className="count">{g.items.length}</span>
              </h2>
              <div className="card">
                {g.items.map((it) => (
                  <Row key={it.paneId} it={it} showWorkspace={workspaceId === null && workspaces.length > 1} onOpen={onOpen} />
                ))}
              </div>
            </section>
          ))
        )}
      </main>
      {(control || needs.length > 0) && (
        <footer className="actions">
          {needs.length > 0 && (
            <button className="action primary" onClick={() => onOpen(needs[0]!.paneId)}>
              <Icon name="next" size={16} /> Next
            </button>
          )}
          {control && (
            <>
              <button className="action" disabled={busy} onClick={() => void start("terminal")}>
                <Icon name="terminal" size={16} /> Terminal
              </button>
              <button className="action" disabled={busy} onClick={() => void start("claude")}>
                <Icon name="sparkles" size={16} /> Claude
              </button>
            </>
          )}
        </footer>
      )}
    </>
  );
}

function Row({ it, showWorkspace, onOpen }: { it: Item; showWorkspace: boolean; onOpen: (paneId: string) => void }) {
  return (
    <button className={`row row-${it.group}`} onClick={() => onOpen(it.paneId)}>
      <Led light={it.light} />
      <span className="row-icon">
        <Icon name={it.agent ? "sparkles" : "terminal"} size={16} />
      </span>
      <span className="row-text">
        <span className="row-top">
          <span className="row-title">{it.title}</span>
          {showWorkspace && it.workspace && <span className="workspace-tag">{it.workspace}</span>}
          <span className="row-when">{ago(it.since)}</span>
        </span>
        {it.detail && <span className="row-sub">{it.detail}</span>}
      </span>
    </button>
  );
}
