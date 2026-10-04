// Now: what needs you, what's working, what just finished, across Spaces or in
// one. A row opens its terminal. With control access, a bar at the bottom
// starts a terminal or a Claude session in the Space shown, and jumps to the
// oldest thing that needs you.

import { useMemo, useState } from "react";
import type { Connection } from "./connection.ts";
import { sections, spaceList, type Item, type Model } from "./model.ts";
import { ago, Icon, Led } from "./ui.tsx";

export function Now({ conn, model, spaceId, onSpace, onOpen }: { conn: Connection; model: Model; spaceId: string | null; onSpace: (id: string | null) => void; onOpen: (paneId: string) => void }) {
  const groups = useMemo(() => sections(model, spaceId), [model, spaceId]);
  const spaces = useMemo(() => spaceList(model), [model]);
  const needs = groups.find((g) => g.group === "needs")?.items ?? [];
  const control = model.scope === "control";
  const [busy, setBusy] = useState(false);
  const spaceName = (id: string | null) => (id ? model.spaces.get(id)?.name : null) ?? "Home";

  const start = async (what: "terminal" | "claude") => {
    if (busy || !conn.client) return;
    setBusy(true);
    try {
      const target = spaceId ?? undefined;
      const paneId = what === "terminal" ? (await conn.client.call("pane.create", { spaceId: target })).id : (await conn.client.call("agent.spawn", { kind: "claude", spaceId: target })).paneId;
      if (paneId) onOpen(paneId);
    } catch {
      // stays on Now; the Mac's log has why
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {spaces.length > 1 && (
        <nav className="chips">
          <button className={`chip${spaceId === null ? " on" : ""}`} onClick={() => onSpace(null)}>
            All
          </button>
          {spaces.map(({ space, needs }) => (
            <button key={space.id} className={`chip${spaceId === space.id ? " on" : ""}`} onClick={() => onSpace(space.id)}>
              {space.name}
              {needs > 0 && <span className="chip-badge">{needs}</span>}
            </button>
          ))}
        </nav>
      )}
      <main className="now">
        {groups.length === 0 ? (
          <div className="empty">
            <Icon name="terminal" size={28} />
            <div>Nothing running{spaceId ? ` in ${spaceName(spaceId)}` : ""}.</div>
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
                  <Row key={it.paneId} it={it} showSpace={spaceId === null && spaces.length > 1} onOpen={onOpen} />
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

function Row({ it, showSpace, onOpen }: { it: Item; showSpace: boolean; onOpen: (paneId: string) => void }) {
  return (
    <button className={`row row-${it.group}`} onClick={() => onOpen(it.paneId)}>
      <Led light={it.light} />
      <span className="row-icon">
        <Icon name={it.agent ? "sparkles" : "terminal"} size={16} />
      </span>
      <span className="row-text">
        <span className="row-top">
          <span className="row-title">{it.title}</span>
          {showSpace && it.space && <span className="space-tag">{it.space}</span>}
          <span className="row-when">{ago(it.since)}</span>
        </span>
        {it.detail && <span className="row-sub">{it.detail}</span>}
      </span>
    </button>
  );
}
