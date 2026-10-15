// Random widget trees and patches for property tests of how patches apply (widget-patch.ts):
// a seeded generator that makes only ops that fit the tree as the ops before left it, and a
// plain model of the ops (a search of the whole tree per op, nothing shared with WireTree)
// to hold appliers to. Used by protocol's test and the repo's test/widget-patch.test.ts.

import type { PatchOp, TreeElement, TreeNode, WidgetPatch, WidgetTree, WireValue } from "../src/widget-tree.ts";

/** mulberry32: the same numbers for the same seed. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GenOptions {
  /** Element types that hold elements. */
  containers: string[];
  /** The element type that holds texts. */
  words: string;
  /** Props for a new element, or a props op's `set`, of this type. */
  props: (type: string, rnd: () => number) => Record<string, WireValue>;
  /** Moves stay among a node's siblings, as React's do (else they may go to any other parent too). */
  siblingMoves?: boolean;
}

const isEl = (n: TreeNode | undefined): n is TreeElement => !!n && n.type !== "#text";

/** The plain model: the tree, and ops applied by searching it. */
export class Model {
  nodes: TreeNode[] = [];
  rev = 0;

  /** A node, its parent's id (0: the top) and the list it is in. */
  find(id: number, list: TreeNode[] = this.nodes, parent = 0): { node: TreeNode; parent: number; list: TreeNode[] } | null {
    for (const n of list) {
      if (n.id === id) return { node: n, parent, list };
      if (isEl(n)) {
        const f = this.find(id, n.children, n.id);
        if (f) return f;
      }
    }
    return null;
  }

  children(parent: number): TreeNode[] {
    return parent === 0 ? this.nodes : (this.find(parent)!.node as TreeElement).children;
  }

  all(list: TreeNode[] = this.nodes, out: TreeNode[] = []): TreeNode[] {
    for (const n of list) {
      out.push(n);
      if (isEl(n)) this.all(n.children, out);
    }
    return out;
  }

  /** The ids from a node up to the top (itself first). */
  chain(id: number): number[] {
    const out: number[] = [];
    for (let at = this.find(id); at; at = at.parent ? this.find(at.parent) : null) out.push(at.node.id);
    return out;
  }

  op(op: PatchOp): void {
    switch (op.op) {
      case "insert":
        this.children(op.parent).splice(op.index, 0, structuredClone(op.node));
        return;
      case "move": {
        const at = this.find(op.id)!;
        at.list.splice(at.list.indexOf(at.node), 1);
        this.children(op.parent).splice(op.index, 0, at.node);
        return;
      }
      case "remove": {
        const at = this.find(op.id)!;
        at.list.splice(at.list.indexOf(at.node), 1);
        return;
      }
      case "props": {
        const n = this.find(op.id)!.node as TreeElement;
        n.props = { ...n.props, ...structuredClone(op.set) };
        for (const k of op.unset) delete n.props[k];
        return;
      }
      case "text":
        (this.find(op.id)!.node as { text: string }).text = op.text;
        return;
    }
  }
}

/** A seeded run: the first tree, then patches, each fitting the model as the ones before left it. */
export class Gen {
  readonly model = new Model();
  private next = 1;
  private readonly rnd: () => number;
  private readonly o: GenOptions;

  constructor(seed: number, o: GenOptions) {
    this.rnd = random(seed);
    this.o = o;
  }

  private int(n: number): number {
    return Math.floor(this.rnd() * n);
  }
  private pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]!;
  }

  /** A new subtree of an element type, `depth` levels deep at most. */
  private element(type: string, depth: number): TreeElement {
    const id = this.next++;
    if (type === this.o.words) return { id, type: type as TreeElement["type"], props: this.o.props(type, this.rnd), children: Array.from({ length: this.int(3) }, () => this.text()) };
    const kids = depth > 0 ? Array.from({ length: this.int(4) }, () => this.element(this.kind(), depth - 1)) : [];
    return { id, type: type as TreeElement["type"], props: this.o.props(type, this.rnd), children: kids };
  }
  private text(): TreeNode {
    return { id: this.next++, type: "#text", text: `t${this.int(100)}` };
  }
  private kind(): string {
    return this.rnd() < 0.4 ? this.o.words : this.pick(this.o.containers);
  }

  tree(): WidgetTree {
    this.model.nodes = Array.from({ length: 1 + this.int(3) }, () => this.element(this.pick(this.o.containers), 3));
    this.model.rev = 1;
    return { kind: "tree", rev: 1, nodes: structuredClone(this.model.nodes) };
  }

  /** One op that fits the model now (and applied to it). */
  op(): PatchOp {
    const nodes = this.model.all();
    const els = nodes.filter(isEl);
    const containers = [0, ...els.filter((e) => e.type !== this.o.words).map((e) => e.id)];
    const roll = this.rnd();
    let op: PatchOp;
    if (roll < 0.3 || nodes.length < 3) {
      const parent = this.pick(containers);
      const holder = parent !== 0 && this.rnd() < 0.3 ? els.find((e) => e.type === this.o.words) : undefined;
      if (holder) op = { op: "insert", parent: holder.id, index: this.int(holder.children.length + 1), node: this.text() };
      else op = { op: "insert", parent, index: this.int(this.model.children(parent).length + 1), node: this.element(this.kind(), 2) };
    } else if (roll < 0.5) {
      const n = this.pick(nodes);
      const at = this.model.find(n.id)!;
      let parent = at.parent;
      if (!this.o.siblingMoves && isEl(n) && this.rnd() < 0.4) {
        // Another parent of its kind that isn't inside it.
        const fits = containers.filter((c) => c === 0 || !this.model.chain(c).includes(n.id));
        if (fits.length) parent = this.pick(fits);
      }
      const len = this.model.children(parent).length - (parent === at.parent ? 1 : 0);
      op = { op: "move", id: n.id, parent, index: this.int(len + 1) };
    } else if (roll < 0.65) {
      op = { op: "remove", id: this.pick(nodes).id };
    } else if (roll < 0.85 && els.length) {
      const e = this.pick(els);
      const keys = Object.keys(e.props);
      op = { op: "props", id: e.id, set: this.o.props(e.type, this.rnd), unset: keys.length && this.rnd() < 0.5 ? [this.pick(keys)] : [] };
    } else {
      const texts = nodes.filter((n) => n.type === "#text");
      op = texts.length ? { op: "text", id: this.pick(texts).id, text: `t${this.int(100)}` } : { op: "remove", id: this.pick(nodes).id };
    }
    this.model.op(op);
    return op;
  }

  /** A patch of 1–4 ops (rev after the model's last). */
  patch(): WidgetPatch {
    const ops = Array.from({ length: 1 + this.int(4) }, () => this.op());
    return { kind: "patch", rev: ++this.model.rev, ops: structuredClone(ops) };
  }
}
