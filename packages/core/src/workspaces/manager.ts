// Workspaces: a directory you work in, with its terminals, agents and windows
// (docs/11-workspaces.md). Identity is the canonical root, so opening a folder is
// attach-or-create. Home (rooted at the home folder) always exists and catches
// everything without a better workspace. Closed workspaces are kept as recent ones.

import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { HOME_WORKSPACE_ID, ICON_NAME, type Workspace, type WorkspaceId } from "@cmd/protocol";
import type { Store } from "../store.ts";
import { placeOf } from "../checkout.ts";
import { canonical, deepest, gitRoot, nameFor } from "./paths.ts";

const VIEW_MAX = 256 * 1024;

/** The checkout a workspace's root is in, without its branch (docs/35); none for Home, whose rows always say where they are. */
function gitOf(s: Pick<Workspace, "root" | "home">): Workspace["git"] {
  if (s.home) return null;
  const at = placeOf(s.root);
  return at && { project: at.project, top: at.top, linked: at.linked };
}

export class WorkspaceManager extends EventEmitter<{ updated: [Workspace]; removed: [WorkspaceId] }> {
  #workspaces = new Map<WorkspaceId, Workspace>();
  #store: Store | null;
  #home: string;

  constructor(store: Store | null, home = os.homedir()) {
    super();
    this.#store = store;
    this.#home = canonical(home, "/", home);
    // Older records: no icon yet, and a hue workspaces no longer have.
    for (const { hue: _, ...s } of (store?.workspaces() ?? []) as (Workspace & { hue?: number })[]) this.#workspaces.set(s.id, { ...s, icon: s.icon ?? null, git: gitOf(s) });
    const h = this.#workspaces.get(HOME_WORKSPACE_ID);
    if (!h || h.root !== this.#home || h.closedAt !== null) {
      const now = Date.now();
      this.#save({
        id: HOME_WORKSPACE_ID,
        name: "Home",
        root: this.#home,
        home: true,
        icon: h?.icon ?? null,
        order: 0,
        closedAt: null,
        createdAt: h?.createdAt ?? now,
        lastActiveAt: h?.lastActiveAt ?? now,
        view: h?.view ?? {},
        git: null,
      });
    }
  }

  /** Notes workspaces whose folder went away or came back (docs/35); a folder that came back gets its checkout read again. */
  check(): void {
    for (const s of this.#workspaces.values()) {
      if (s.home) continue;
      let gone = true;
      try {
        gone = !fs.statSync(s.root).isDirectory();
      } catch {}
      if (gone === !!s.gone) continue;
      if (gone) s.gone = true;
      else {
        delete s.gone;
        s.git = gitOf(s);
      }
      this.#save(s);
    }
  }

  get(id: WorkspaceId): Workspace | undefined {
    return this.#workspaces.get(id);
  }

  home(): Workspace {
    return this.#workspaces.get(HOME_WORKSPACE_ID)!;
  }

  /** Open workspaces in switcher order; closed: the closed ones too, after them, most recent first. */
  list(closed = false): Workspace[] {
    // The picker asks for closed ones too: a good moment to see what's gone.
    if (closed) this.check();
    const all = [...this.#workspaces.values()];
    const open = all.filter((s) => s.closedAt === null).sort((a, b) => a.order - b.order);
    if (!closed) return open.map((s) => ({ ...s }));
    const recent = all.filter((s) => s.closedAt !== null).sort((a, b) => b.closedAt! - a.closedAt!);
    return [...open, ...recent].map((s) => ({ ...s }));
  }

  /** Canonical root for an open request (see workspace.open). */
  rootFor(p: string, cwd?: string, git = false): string {
    const c = canonical(p, cwd ?? this.#home, this.#home);
    return (git && gitRoot(c)) || c;
  }

  /** Attach-or-create by root; a closed workspace with this root is reopened. The root must be an existing folder. */
  open(p: string, o: { cwd?: string; gitRoot?: boolean } = {}): { workspace: Workspace; created: boolean } {
    const root = this.rootFor(p, o.cwd, o.gitRoot);
    let st: fs.Stats;
    try {
      st = fs.statSync(root);
    } catch {
      throw new Error(`no such folder: ${root}`);
    }
    if (!st.isDirectory()) throw new Error(`not a folder: ${root}`);
    const now = Date.now();
    const existing = [...this.#workspaces.values()].find((s) => s.root === root);
    if (existing) {
      if (existing.closedAt !== null) {
        existing.closedAt = null;
        existing.order = this.#nextOrder();
      }
      existing.lastActiveAt = now;
      existing.git = gitOf(existing);
      delete existing.gone;
      this.#save(existing);
      return { workspace: { ...existing }, created: false };
    }
    const name = nameFor(root);
    const workspace: Workspace = {
      id: randomUUID(),
      name,
      root,
      home: false,
      icon: null,
      order: this.#nextOrder(),
      closedAt: null,
      createdAt: now,
      lastActiveAt: now,
      view: {},
      git: null,
    };
    workspace.git = gitOf(workspace);
    this.#save(workspace);
    return { workspace: { ...workspace }, created: true };
  }

  /**
   * The open workspace a path belongs to: the one whose root most deeply contains it
   * (nested workspaces win over their parents), else Home.
   */
  match(p: string, cwd?: string): Workspace {
    const c = canonical(p, cwd ?? this.#home, this.#home);
    return { ...(deepest(this.#open(), c) ?? this.home()) };
  }

  /** The open workspace an already canonical path belongs to, as `match` decides, without touching the disk (no path: Home). */
  of(p: string | null): WorkspaceId {
    return (p && deepest(this.#open(), p)?.id) || HOME_WORKSPACE_ID;
  }

  update(id: WorkspaceId, patch: { name?: string; icon?: string | null; order?: number; view?: Record<string, unknown>; active?: boolean }): Workspace {
    const s = this.#must(id);
    if (patch.active) s.lastActiveAt = Date.now();
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 100);
      if (!name) throw new Error("a workspace needs a name");
      s.name = name;
    }
    if (patch.icon !== undefined) {
      if (patch.icon !== null && (patch.icon.length > 64 || !ICON_NAME.test(patch.icon))) throw new Error(`not an SF Symbol name: ${patch.icon}`);
      s.icon = patch.icon;
    }
    if (patch.order !== undefined) s.order = patch.order;
    if (patch.view) {
      const view = { ...s.view };
      for (const [k, v] of Object.entries(patch.view)) {
        if (v === null || v === undefined) delete view[k];
        else view[k] = v;
      }
      if (JSON.stringify(view).length > VIEW_MAX) throw new Error("workspace.update: view too large");
      s.view = view;
    }
    this.#save(s);
    return { ...s };
  }

  /** Mark closed; the caller has already removed its terminals and windows. */
  markClosed(id: WorkspaceId): void {
    const s = this.#must(id);
    if (s.home) throw new Error("Home can't be closed");
    if (s.closedAt !== null) return;
    s.closedAt = Date.now();
    this.#save(s);
  }

  forget(id: WorkspaceId): void {
    const s = this.#must(id);
    if (s.closedAt === null) throw new Error("close the workspace before forgetting it");
    this.#workspaces.delete(id);
    this.#store?.deleteWorkspace(id);
    this.emit("removed", id);
  }

  /** An open workspace by id; throws for unknown or closed ones. */
  mustOpen(id: WorkspaceId): Workspace {
    const s = this.#must(id);
    if (s.closedAt !== null) throw new Error(`Workspace is closed: ${s.name}`);
    return s;
  }

  #open(): Workspace[] {
    return [...this.#workspaces.values()].filter((s) => s.closedAt === null);
  }

  #nextOrder(): number {
    return Math.max(0, ...this.#open().map((s) => s.order)) + 1;
  }

  #must(id: WorkspaceId): Workspace {
    const s = this.#workspaces.get(id);
    if (!s) throw new Error(`no such workspace: ${id}`);
    return s;
  }

  #save(s: Workspace): void {
    this.#workspaces.set(s.id, s);
    this.#store?.saveWorkspace(s);
    this.emit("updated", { ...s });
  }
}
