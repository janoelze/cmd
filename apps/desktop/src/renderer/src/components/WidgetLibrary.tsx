// The Widget Library (docs/16-widgets.md): a sheet of cards, yours (by last
// use), built-in ones and examples, with New Widget with Magic beside the
// search field. A click puts a widget on the desk of this Space (an example:
// your copy of it); the search field only searches. Each card's menu adds, and
// for yours renames, duplicates, shows the folder and deletes.

import { Badge, Button, Dialog, EmptyState, IconButton, SearchField, TextField, iconNode } from "@cmd/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WidgetEntry } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { newMagic, selectPane } from "../actions.ts";
import { showContextMenu } from "../context.ts";
import { setLibrary, useStoreValue } from "../store.ts";
import "./library.css";

const fileUrl = (p: string) => `cmd-file://local/?path=${encodeURIComponent(p)}`;

function matches(e: WidgetEntry, query: string): boolean {
  const hay = [e.title, e.description, e.request].filter(Boolean).join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

export function WidgetLibrary({ onClose }: { onClose: () => void }) {
  const library = useStoreValue((s) => s.library);
  const spaceId = useStoreValue((s) => s.spaceId);
  const windows = useStoreValue((s) => s.windows);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<WidgetEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Fresh on open (widget.library events keep it current while it's open).
  useEffect(() => void cmd.call("widget.list", {}).then(setLibrary, () => {}), []);

  const shown = useMemo(() => library.filter((e) => matches(e, query)), [library, query]);
  const yours = shown.filter((e) => e.source === "yours");
  const builtin = shown.filter((e) => e.source === "builtin");
  const examples = shown.filter((e) => e.source === "example");
  const here = (e: WidgetEntry) => e.windows.some((id) => windows.get(id)?.spaceId === spaceId);

  const fail = (err: unknown) => setError((err as Error).message);
  const add = async (e: WidgetEntry) => {
    try {
      const w = await cmd.call("widget.add", { ref: e.ref, spaceId });
      onClose();
      selectPane(w.id);
    } catch (err) {
      fail(err);
    }
  };
  const make = () => {
    onClose();
    void newMagic();
  };
  const remove = async (e: WidgetEntry) => {
    const open = e.windows.length;
    const ok = await cmd.confirm({
      message: `Delete “${e.title}”?`,
      detail: `Its files and every version of it are deleted.${open ? ` ${open === 1 ? "The window showing it closes" : `The ${open} windows showing it close`}.` : ""} This can't be undone.`,
      confirm: "Delete",
    });
    if (!ok) return;
    try {
      // The core keeps widgets that are on the desk: take them off first.
      for (const id of e.windows) await cmd.call("window.close", { id });
      await cmd.call("widget.delete", { ref: e.ref });
    } catch (err) {
      fail(err);
    }
  };
  const menu = (e: WidgetEntry) =>
    void showContextMenu(
      e.source !== "yours"
        ? [{ label: "Add to Desk", run: () => void add(e) }]
        : [
            { label: "Add to Desk", run: () => void add(e) },
            "-",
            { label: "Rename…", run: () => setRenaming(e) },
            { label: "Duplicate", run: () => void cmd.call("widget.duplicate", { ref: e.ref }).catch(fail) },
            { label: "Show in Finder", run: () => e.dir && cmd.revealPath(e.dir), enabled: !!e.dir },
            "-",
            { label: "Delete…", run: () => void remove(e) },
          ],
    );

  const card = (e: WidgetEntry) => (
    <div key={e.ref} className="wl-card" role="button" tabIndex={0} onClick={() => void add(e)} onKeyDown={(k) => k.key === "Enter" && void add(e)} onContextMenu={(ev) => (ev.preventDefault(), menu(e))}>
      <div className="wl-thumb">{e.shot ? <img src={fileUrl(e.shot)} alt="" loading="lazy" /> : <span className="wl-thumb-icon">{iconNode(e.icon, 28, "light")}</span>}</div>
      <div className="wl-meta">
        <div className="wl-title">
          {e.source === "yours" && <span className="wl-spark" data-tip="Made with Magic">✦</span>}
          <span className="wl-name">{e.title}</span>
          {here(e) && <Badge size="sm">Here</Badge>}
        </div>
        {(e.description || e.request) && <div className="wl-desc">{e.description || e.request}</div>}
      </div>
      <IconButton className="wl-more" icon="ellipsis" size="sm" label="More" onClick={(ev) => (ev.stopPropagation(), menu(e))} />
    </div>
  );

  return (
    <Dialog open onClose={onClose} title="Widget Library" width={720} className="widget-library" divided padded={false}>
      <div className="wl-search">
        <SearchField
          fill
          ref={input}
          size="lg"
          value={query}
          placeholder="Search widgets"
          onChange={setQuery}
          autoFocus
          onKeyDown={(k) => {
            if (k.key === "Enter" && shown[0]) void add(yours[0] ?? shown[0]);
          }}
        />
        <Button variant="primary" size="lg" icon="sparkles" onClick={make}>
          New Widget with Magic
        </Button>
      </div>
      <div className="wl-body">
        {error && <div className="wl-error">{error}</div>}
        {(yours.length > 0 || !query) && (
          <section className="wl-section">
            <div className="wl-heading">Your Widgets</div>
            {yours.length > 0 ? <div className="wl-grid">{yours.map(card)}</div> : <EmptyState compact>Widgets you make with Magic, or add from the examples, are kept here.</EmptyState>}
          </section>
        )}
        {builtin.length > 0 && (
          <section className="wl-section">
            <div className="wl-heading">Built-in</div>
            <div className="wl-grid">{builtin.map(card)}</div>
          </section>
        )}
        {examples.length > 0 && (
          <section className="wl-section">
            <div className="wl-heading">Examples</div>
            <div className="wl-grid">{examples.map(card)}</div>
          </section>
        )}
        {query && !shown.length && <EmptyState compact>Nothing matches “{query}”. New Widget with Magic makes one.</EmptyState>}
      </div>
      {renaming && <RenameDialog entry={renaming} onDone={() => setRenaming(null)} onError={fail} />}
    </Dialog>
  );
}

function RenameDialog({ entry, onDone, onError }: { entry: WidgetEntry; onDone: () => void; onError: (e: unknown) => void }) {
  const [title, setTitle] = useState(entry.title);
  const save = () => {
    if (title.trim() && title.trim() !== entry.title) void cmd.call("widget.rename", { ref: entry.ref, title }).catch(onError);
    onDone();
  };
  return (
    <Dialog
      open
      onClose={onDone}
      title="Rename Widget"
      width={360}
      position="center"
      actions={
        <>
          <Button onClick={onDone}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!title.trim()}>
            Rename
          </Button>
        </>
      }
    >
      <TextField value={title} onChange={setTitle} fill autoFocus onKeyDown={(k) => k.key === "Enter" && save()} />
    </Dialog>
  );
}
