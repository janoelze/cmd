// The last full tree of a package widget's window (docs/56, "The wire"), kept by the core so
// a window drawn later gets the whole tree, not a stream of patches. Patches apply in order,
// each op to the tree the ops before it left; a patch whose rev doesn't follow, or that names
// a node this tree lacks, is refused and the process is asked for the whole tree again.

import { TREE_ROOT, type PatchOp, type TreeElement, type TreeNode, type WidgetPatch, type WidgetTree } from "@cmd/protocol";

export class TreeState {
  rev = 0;
  #roots: TreeNode[] = [];
  /** Every node by id, with its parent's id. */
  #nodes = new Map<number, { node: TreeNode; parent: number }>();

  /** Whether there is a tree yet. */
  get ready(): boolean {
    return this.rev > 0;
  }

  /** The whole tree as a message. */
  tree(): WidgetTree {
    return { kind: "tree", rev: this.rev, nodes: this.#roots };
  }

  reset(): void {
    this.rev = 0;
    this.#roots = [];
    this.#nodes.clear();
  }

  setTree(t: WidgetTree): void {
    this.#roots = t.nodes;
    this.#nodes.clear();
    for (const n of t.nodes) this.#index(n, TREE_ROOT);
    this.rev = t.rev;
  }

  /** Apply a patch; false (and the tree as it was before, rev unchanged) when it doesn't fit. */
  apply(p: WidgetPatch): boolean {
    if (!this.ready || p.rev !== this.rev + 1) return false;
    for (const op of p.ops) {
      if (!this.#op(op)) {
        this.reset();
        return false;
      }
    }
    this.rev = p.rev;
    return true;
  }

  #children(parent: number): TreeNode[] | null {
    if (parent === TREE_ROOT) return this.#roots;
    const n = this.#nodes.get(parent)?.node;
    return n && n.type !== "#text" ? n.children : null;
  }

  #index(n: TreeNode, parent: number): void {
    this.#nodes.set(n.id, { node: n, parent });
    if (n.type !== "#text") for (const c of n.children) this.#index(c, n.id);
  }

  #unindex(n: TreeNode): void {
    this.#nodes.delete(n.id);
    if (n.type !== "#text") for (const c of n.children) this.#unindex(c);
  }

  /** Take a node out of its parent's children; the node, or null. */
  #detach(id: number): TreeNode | null {
    const at = this.#nodes.get(id);
    if (!at) return null;
    const list = this.#children(at.parent);
    const i = list ? list.indexOf(at.node) : -1;
    if (!list || i < 0) return null;
    list.splice(i, 1);
    return at.node;
  }

  #op(op: PatchOp): boolean {
    switch (op.op) {
      case "insert": {
        const list = this.#children(op.parent);
        if (!list || op.index < 0 || op.index > list.length || this.#nodes.has(op.node.id)) return false;
        list.splice(op.index, 0, op.node);
        this.#index(op.node, op.parent);
        return true;
      }
      case "move": {
        const node = this.#detach(op.id);
        const list = this.#children(op.parent);
        if (!node || !list || op.index < 0 || op.index > list.length) return false;
        list.splice(op.index, 0, node);
        this.#nodes.set(op.id, { node, parent: op.parent });
        return true;
      }
      case "remove": {
        const node = this.#detach(op.id);
        if (!node) return false;
        this.#unindex(node);
        return true;
      }
      case "props": {
        const n = this.#nodes.get(op.id)?.node;
        if (!n || n.type === "#text") return false;
        const el = n as TreeElement;
        el.props = { ...el.props, ...op.set };
        for (const k of op.unset) delete el.props[k];
        return true;
      }
      case "text": {
        const n = this.#nodes.get(op.id)?.node;
        if (!n || n.type !== "#text") return false;
        n.text = op.text;
        return true;
      }
    }
  }
}
