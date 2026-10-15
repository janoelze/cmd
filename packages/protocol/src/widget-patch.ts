// How a widget's tree patches apply (docs/56, "The wire"): the one place the ops of
// widget-tree.ts's PatchOp (insert, move, remove, props, text) and their failures are
// written. The core keeps the last whole tree per window with it (widgets/host/tree.ts),
// the renderer the tree it draws (windows/package/tree.ts), the widget tests the tree
// they look at (@cmd/widget-api/testing): they differ only by the hooks.
//
// - `immutable`: a change copies the node and its ancestors and leaves the rest as it
//   was (the renderer: React redraws only what a patch touched). Otherwise in place.
// - `adopt`: what to keep of a node from the wire (a copy; the renderer's sanitised one).
//   It may drop a node, keeping a stand-in in its place so later indexes still line up:
//   ops on a dropped node move or remove its stand-in and are otherwise ignored, ops
//   inside a dropped subtree are ignored, and a node moved into one is dropped too.
// - `props`, `text`: what to keep of a props op's `set` and a text op's words.
//
// A patch that doesn't fit (a rev that doesn't follow, an unknown node, an index out of
// range, an id already used) throws a PatchError; the tree is then lost (`ready` is false)
// until the next whole tree, and whoever holds it asks for one (`resync`).

import { TREE_ROOT, type PatchOp, type TreeElement, type TreeNode, type TreeText, type WidgetPatch, type WidgetTree, type WireValue } from "./widget-tree.ts";

/** Why a patch didn't apply. "stale": its rev is one already applied (old news, not a reason to resync). */
export type PatchFailure = "stale" | "gap" | "unknown" | "index" | "duplicate" | "kind" | "cycle";

export class PatchError extends Error {
  readonly reason: PatchFailure;
  constructor(reason: PatchFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface PatchHooks {
  /** Copy-on-write: unchanged nodes keep their identity, changed ones and their ancestors are new objects. */
  immutable?: boolean;
  /**
   * The node to keep for one from the wire, inserted under `parent` (null: the top). Call
   * `drop(n)` for each node (and its subtree, as sent) left out, and keep a stand-in with its id.
   * The default keeps the wire's node itself.
   */
  adopt?(node: TreeNode, parent: TreeElement | null, drop: (n: TreeNode) => void): TreeNode;
  /** The props of a `props` op's `set` to keep (default: all). */
  props?(el: TreeElement, set: Record<string, WireValue>): Record<string, WireValue>;
  /** The words to keep for a `text` op (default: as sent). */
  text?(node: TreeText, text: string, parent: TreeElement | null): string;
}

const isEl = (n: TreeNode | undefined): n is TreeElement => !!n && n.type !== "#text";

/** A widget's tree, whole and then patched. */
export class WireTree {
  rev = 0;
  #roots: TreeNode[] = [];
  #byId = new Map<number, TreeNode>();
  #parentOf = new Map<number, number>();
  /** Ids the adopt hook dropped (their subtrees as sent): see the file's comment. */
  #dropped = new Set<number>();
  /** Objects this patch made (immutable): not seen by anyone yet, so changed in place. */
  #fresh = new WeakSet<object>();
  readonly #hooks: PatchHooks;

  constructor(hooks: PatchHooks = {}) {
    this.#hooks = hooks;
  }

  /** Whether there is a tree (one came, and no patch since failed). */
  get ready(): boolean {
    return this.rev > 0;
  }

  /** The top-level nodes. With `immutable`, a new array whenever they change. */
  get roots(): readonly TreeNode[] {
    return this.#roots;
  }

  /** The whole tree as a message. */
  tree(): WidgetTree {
    return { kind: "tree", rev: this.rev, nodes: this.#roots };
  }

  get(id: number): TreeNode | undefined {
    return this.#byId.get(id);
  }

  /** The id of a node's parent (TREE_ROOT for the top), or undefined. */
  parentOf(id: number): number | undefined {
    return this.#parentOf.get(id);
  }

  /** Every node of the tree. */
  nodes(): IterableIterator<TreeNode> {
    return this.#byId.values();
  }

  reset(): void {
    this.rev = 0;
    this.#roots = [];
    this.#byId.clear();
    this.#parentOf.clear();
    this.#dropped.clear();
  }

  /** Takes a whole tree. */
  load(t: WidgetTree): void {
    this.reset();
    this.#roots = t.nodes.map((n) => this.#adopt(n, TREE_ROOT));
    this.rev = t.rev;
  }

  /** Applies a patch, or throws a PatchError (and the tree is lost, unless it was only stale). */
  apply(p: WidgetPatch): void {
    if (this.ready && p.rev <= this.rev) throw new PatchError("stale", `patch rev ${p.rev}: already at ${this.rev}`);
    if (!this.ready || p.rev !== this.rev + 1) throw new PatchError("gap", this.ready ? `patch rev ${p.rev} after ${this.rev}` : `patch rev ${p.rev} before a tree`);
    this.#fresh = new WeakSet();
    try {
      for (const op of p.ops) this.#op(op);
    } catch (e) {
      this.reset();
      throw e;
    }
    this.rev = p.rev;
  }

  // ── the ops ───────────────────────────────────────────

  #op(op: PatchOp): void {
    switch (op.op) {
      case "insert": {
        if (this.#dropped.has(op.parent)) return this.#forget(op.node);
        if (this.#byId.has(op.node.id) || this.#dropped.has(op.node.id)) throw new PatchError("duplicate", `insert of node ${op.node.id}, which is already in the tree`);
        const list = this.#children(op.parent);
        if (!(op.index >= 0 && op.index <= list.length)) throw new PatchError("index", `insert at ${op.index} of ${list.length} under ${op.parent}`);
        const node = this.#adopt(op.node, op.parent);
        this.#edit(op.parent, (l) => l.splice(op.index, 0, node));
        return;
      }
      case "move": {
        const n = this.#byId.get(op.id);
        if (!n) {
          if (this.#dropped.has(op.id)) return; // inside a dropped subtree
          throw new PatchError("unknown", `move of node ${op.id}, which isn't in the tree`);
        }
        if (this.#dropped.has(op.parent)) {
          this.#detach(op.id);
          return this.#forget(n);
        }
        for (let p: number | undefined = op.parent; p !== undefined && p !== TREE_ROOT; p = this.#parentOf.get(p)) if (p === op.id) throw new PatchError("cycle", `move of node ${op.id} into itself`);
        const len = this.#children(op.parent).length - (this.#parentOf.get(op.id) === op.parent ? 1 : 0);
        this.#detach(op.id);
        if (!(op.index >= 0 && op.index <= len)) throw new PatchError("index", `move to ${op.index} of ${len} under ${op.parent}`);
        this.#parentOf.set(op.id, op.parent);
        this.#edit(op.parent, (l) => l.splice(op.index, 0, n));
        return;
      }
      case "remove": {
        const n = this.#byId.get(op.id);
        if (!n) {
          if (this.#dropped.has(op.id)) return;
          throw new PatchError("unknown", `remove of node ${op.id}, which isn't in the tree`);
        }
        this.#detach(op.id);
        this.#unindex(n);
        return;
      }
      case "props": {
        if (this.#dropped.has(op.id)) return;
        const n = this.#byId.get(op.id);
        if (!n) throw new PatchError("unknown", `props for node ${op.id}, which isn't in the tree`);
        if (!isEl(n)) throw new PatchError("kind", `props for node ${op.id}, which is a text`);
        const props = { ...n.props, ...(this.#hooks.props ? this.#hooks.props(n, op.set) : op.set) };
        for (const k of op.unset) delete props[k];
        this.#change(n, (c) => ((c as TreeElement).props = props));
        return;
      }
      case "text": {
        if (this.#dropped.has(op.id)) return;
        const n = this.#byId.get(op.id);
        if (!n) throw new PatchError("unknown", `text for node ${op.id}, which isn't in the tree`);
        if (isEl(n)) throw new PatchError("kind", `text for node ${op.id}, which is an element`);
        const text = this.#hooks.text ? this.#hooks.text(n, op.text, this.#elementAt(this.#parentOf.get(op.id)!)) : op.text;
        this.#change(n, (c) => ((c as TreeText).text = text));
        return;
      }
    }
  }

  // ── the index ─────────────────────────────────────────

  #elementAt(id: number): TreeElement | null {
    const n = id === TREE_ROOT ? undefined : this.#byId.get(id);
    return isEl(n) ? n : null;
  }

  /** A node from the wire, through the adopt hook, indexed under `parent`. */
  #adopt(n: TreeNode, parent: number): TreeNode {
    const kept = this.#hooks.adopt ? this.#hooks.adopt(n, this.#elementAt(parent), (d) => this.#forget(d)) : n;
    this.#index(kept, parent);
    return kept;
  }

  #index(n: TreeNode, parent: number): void {
    this.#byId.set(n.id, n);
    this.#parentOf.set(n.id, parent);
    if (isEl(n)) for (const c of n.children) this.#index(c, n.id);
  }

  #unindex(n: TreeNode): void {
    this.#byId.delete(n.id);
    this.#parentOf.delete(n.id);
    if (isEl(n)) for (const c of n.children) this.#unindex(c);
  }

  /** Marks a subtree (as sent, or as kept) dropped, and takes what of it is indexed out of the index. */
  #forget(n: TreeNode): void {
    this.#dropped.add(n.id);
    if (this.#byId.get(n.id) === n) {
      this.#byId.delete(n.id);
      this.#parentOf.delete(n.id);
    }
    if (isEl(n)) for (const c of n.children ?? []) this.#forget(c);
  }

  // ── the lists ─────────────────────────────────────────

  #children(parent: number): readonly TreeNode[] {
    if (parent === TREE_ROOT) return this.#roots;
    const p = this.#byId.get(parent);
    if (!p) throw new PatchError("unknown", `node ${parent} isn't in the tree`);
    if (!isEl(p)) throw new PatchError("kind", `node ${parent} is a text, which has no children`);
    return p.children;
  }

  /** Takes a node out of its parent's list (it stays indexed). */
  #detach(id: number): void {
    const parent = this.#parentOf.get(id)!;
    const i = this.#children(parent).findIndex((c) => c.id === id);
    if (i < 0) throw new PatchError("unknown", `node ${id} isn't among its parent's children`);
    this.#edit(parent, (l) => l.splice(i, 1));
  }

  /** Changes `parent`'s list of children: in place, or (immutable) on a copy put in place of it. */
  #edit(parent: number, fn: (list: TreeNode[]) => void): void {
    const list = this.#children(parent) as TreeNode[];
    if (!this.#hooks.immutable || this.#fresh.has(list)) return void fn(list);
    const copy = [...list];
    this.#fresh.add(copy);
    fn(copy);
    if (parent === TREE_ROOT) this.#roots = copy;
    else this.#change(this.#byId.get(parent)!, (p) => ((p as TreeElement).children = copy));
  }

  /** Changes a node: in place, or (immutable) on a copy put in place of it, up to the top. */
  #change(n: TreeNode, fn: (n: TreeNode) => void): void {
    if (!this.#hooks.immutable || this.#fresh.has(n)) return void fn(n);
    const copy = { ...n };
    this.#fresh.add(copy);
    fn(copy);
    this.#byId.set(n.id, copy);
    const parent = this.#parentOf.get(n.id)!;
    const i = this.#children(parent).indexOf(n);
    this.#edit(parent, (l) => (l[i] = copy));
  }
}
