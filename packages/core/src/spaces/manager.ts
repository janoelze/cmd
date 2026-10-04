// Spaces: a directory you work in, with its terminals, agents and windows
// (docs/11-spaces.md). Identity is the canonical root, so opening a folder is
// attach-or-create. Home (rooted at the home folder) always exists and catches
// everything without a better Space. Closed Spaces are kept as recent ones.

import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { HOME_SPACE_ID, ICON_NAME, type Space, type SpaceId } from "@cmd/protocol";
import type { Store } from "../store.ts";
import { canonical, deepest, gitRoot, nameFor } from "./paths.ts";

const VIEW_MAX = 256 * 1024;

export class SpaceManager extends EventEmitter<{ updated: [Space]; removed: [SpaceId] }> {
  #spaces = new Map<SpaceId, Space>();
  #store: Store | null;
  #home: string;

  constructor(store: Store | null, home = os.homedir()) {
    super();
    this.#store = store;
    this.#home = canonical(home, "/", home);
    // Older records: no icon yet, and a hue Spaces no longer have.
    for (const { hue: _, ...s } of (store?.spaces() ?? []) as (Space & { hue?: number })[]) this.#spaces.set(s.id, { ...s, icon: s.icon ?? null });
    const h = this.#spaces.get(HOME_SPACE_ID);
    if (!h || h.root !== this.#home || h.closedAt !== null) {
      const now = Date.now();
      this.#save({
        id: HOME_SPACE_ID,
        name: "Home",
        root: this.#home,
        home: true,
        icon: h?.icon ?? null,
        order: 0,
        closedAt: null,
        createdAt: h?.createdAt ?? now,
        lastActiveAt: h?.lastActiveAt ?? now,
        view: h?.view ?? {},
      });
    }
  }

  get(id: SpaceId): Space | undefined {
    return this.#spaces.get(id);
  }

  home(): Space {
    return this.#spaces.get(HOME_SPACE_ID)!;
  }

  /** Open Spaces in switcher order; closed: the closed ones too, after them, most recent first. */
  list(closed = false): Space[] {
    const all = [...this.#spaces.values()];
    const open = all.filter((s) => s.closedAt === null).sort((a, b) => a.order - b.order);
    if (!closed) return open.map((s) => ({ ...s }));
    const recent = all.filter((s) => s.closedAt !== null).sort((a, b) => b.closedAt! - a.closedAt!);
    return [...open, ...recent].map((s) => ({ ...s }));
  }

  /** Canonical root for an open request (see space.open). */
  rootFor(p: string, cwd?: string, git = false): string {
    const c = canonical(p, cwd ?? this.#home, this.#home);
    return (git && gitRoot(c)) || c;
  }

  /** Attach-or-create by root; a closed Space with this root is reopened. The root must be an existing folder. */
  open(p: string, o: { cwd?: string; gitRoot?: boolean } = {}): { space: Space; created: boolean } {
    const root = this.rootFor(p, o.cwd, o.gitRoot);
    let st: fs.Stats;
    try {
      st = fs.statSync(root);
    } catch {
      throw new Error(`no such folder: ${root}`);
    }
    if (!st.isDirectory()) throw new Error(`not a folder: ${root}`);
    const now = Date.now();
    const existing = [...this.#spaces.values()].find((s) => s.root === root);
    if (existing) {
      if (existing.closedAt !== null) {
        existing.closedAt = null;
        existing.order = this.#nextOrder();
      }
      existing.lastActiveAt = now;
      this.#save(existing);
      return { space: { ...existing }, created: false };
    }
    const name = nameFor(root);
    const space: Space = {
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
    };
    this.#save(space);
    return { space: { ...space }, created: true };
  }

  /**
   * The open Space a path belongs to: the one whose root most deeply contains it
   * (nested Spaces win over their parents), else Home.
   */
  match(p: string, cwd?: string): Space {
    const c = canonical(p, cwd ?? this.#home, this.#home);
    return { ...(deepest(this.#open(), c) ?? this.home()) };
  }

  update(id: SpaceId, patch: { name?: string; icon?: string | null; order?: number; view?: Record<string, unknown>; active?: boolean }): Space {
    const s = this.#must(id);
    if (patch.active) s.lastActiveAt = Date.now();
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 100);
      if (!name) throw new Error("a Space needs a name");
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
      if (JSON.stringify(view).length > VIEW_MAX) throw new Error("space.update: view too large");
      s.view = view;
    }
    this.#save(s);
    return { ...s };
  }

  /** Mark closed; the caller has already removed its terminals and windows. */
  markClosed(id: SpaceId): void {
    const s = this.#must(id);
    if (s.home) throw new Error("Home can't be closed");
    if (s.closedAt !== null) return;
    s.closedAt = Date.now();
    this.#save(s);
  }

  forget(id: SpaceId): void {
    const s = this.#must(id);
    if (s.closedAt === null) throw new Error("close the Space before forgetting it");
    this.#spaces.delete(id);
    this.#store?.deleteSpace(id);
    this.emit("removed", id);
  }

  /** An open Space by id; throws for unknown or closed ones. */
  mustOpen(id: SpaceId): Space {
    const s = this.#must(id);
    if (s.closedAt !== null) throw new Error(`Space is closed: ${s.name}`);
    return s;
  }

  #open(): Space[] {
    return [...this.#spaces.values()].filter((s) => s.closedAt === null);
  }

  #nextOrder(): number {
    return Math.max(0, ...this.#open().map((s) => s.order)) + 1;
  }

  #must(id: SpaceId): Space {
    const s = this.#spaces.get(id);
    if (!s) throw new Error(`no such Space: ${id}`);
    return s;
  }

  #save(s: Space): void {
    this.#spaces.set(s.id, s);
    this.#store?.saveSpace(s);
    this.emit("updated", { ...s });
  }
}
