// How a widget's tree patches apply (widget-patch.ts): each op and each way a patch fails,
// then random runs of patches held to a plain model of the ops, applied in place and
// copy-on-write (the same tree; a copy keeps every node a patch didn't touch and leaves the
// tree before it as it was), and through a hook that drops elements (the model's tree with
// a stand-in for each dropped subtree).

import { describe, expect, it } from "vitest";
import { PatchError, WireTree, type PatchHooks } from "../src/widget-patch.ts";
import type { PatchOp, TreeElement, TreeNode, WidgetPatch, WireValue } from "../src/widget-tree.ts";
import { Gen, Model, type GenOptions } from "./random-patches.ts";

const el = (id: number, type: string, children: TreeNode[] = [], props: Record<string, WireValue> = {}) => ({ id, type, props, children }) as TreeElement;
const txt = (id: number, text: string): TreeNode => ({ id, type: "#text", text });
const patch = (rev: number, ...ops: PatchOp[]): WidgetPatch => ({ kind: "patch", rev, ops });
/** The test's element that a hook drops (not one of API 1). */
const bad = (n: TreeNode) => (n.type as string) === "Bad";
const ids = (nodes: readonly TreeNode[]): unknown => nodes.map((n) => (n.type === "#text" ? n.text : [n.id, ids(n.children)]));

function start(hooks: PatchHooks = {}) {
  const t = new WireTree(hooks);
  t.load({ kind: "tree", rev: 1, nodes: [el(1, "Stack", [el(2, "Text", [txt(3, "a")]), el(4, "Text"), el(5, "Stack")])] });
  return t;
}

const reason = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PatchError) return e.reason;
    throw e;
  }
  return "applied";
};

describe("the ops", () => {
  for (const immutable of [false, true])
    it(`insert, move, remove, props and text, in order (${immutable ? "copy-on-write" : "in place"})`, () => {
      const t = start({ immutable });
      t.apply(patch(2, { op: "insert", parent: 1, index: 3, node: el(6, "Text", [txt(7, "b")]) }, { op: "move", id: 6, parent: 1, index: 0 }));
      expect(ids(t.roots)).toEqual([[1, [[6, ["b"]], [2, ["a"]], [4, []], [5, []]]]]);
      t.apply(patch(3, { op: "move", id: 4, parent: 5, index: 0 }, { op: "remove", id: 2 }, { op: "text", id: 7, text: "c" }, { op: "props", id: 6, set: { tone: "dim", mono: true }, unset: [] }, { op: "props", id: 6, set: {}, unset: ["mono"] }));
      expect(ids(t.roots)).toEqual([[1, [[6, ["c"]], [5, [[4, []]]]]]]);
      expect((t.get(6) as TreeElement).props).toEqual({ tone: "dim" });
      expect(t.get(3)).toBeUndefined();
      expect(t.parentOf(4)).toBe(5);
      expect(t.rev).toBe(3);
    });

  it("a move's index counts after taking the node out", () => {
    const t = start();
    t.apply(patch(2, { op: "move", id: 2, parent: 1, index: 2 }));
    expect(ids(t.roots)).toEqual([[1, [[4, []], [5, []], [2, ["a"]]]]]);
    expect(reason(() => t.apply(patch(3, { op: "move", id: 2, parent: 1, index: 3 })))).toBe("index");
  });

  it("refuses what doesn't fit, and the tree is lost until the next whole one", () => {
    const cases: [PatchOp, string][] = [
      [{ op: "remove", id: 99 }, "unknown"],
      [{ op: "move", id: 99, parent: 1, index: 0 }, "unknown"],
      [{ op: "insert", parent: 99, index: 0, node: txt(9, "x") }, "unknown"],
      [{ op: "insert", parent: 1, index: 4, node: txt(9, "x") }, "index"],
      [{ op: "insert", parent: 1, index: -1, node: txt(9, "x") }, "index"],
      [{ op: "insert", parent: 1, index: 0, node: txt(4, "x") }, "duplicate"],
      [{ op: "insert", parent: 3, index: 0, node: txt(9, "x") }, "kind"],
      [{ op: "props", id: 3, set: {}, unset: [] }, "kind"],
      [{ op: "text", id: 2, text: "x" }, "kind"],
      [{ op: "move", id: 1, parent: 5, index: 0 }, "cycle"],
      [{ op: "move", id: 1, parent: 1, index: 0 }, "cycle"],
    ];
    for (const [op, why] of cases) {
      const t = start();
      expect(reason(() => t.apply(patch(2, op))), JSON.stringify(op)).toBe(why);
      expect(t.ready).toBe(false);
      expect(reason(() => t.apply(patch(3, { op: "remove", id: 2 })))).toBe("gap");
    }
  });

  it("a rev gap or a patch before any tree is a gap; an old rev is stale and changes nothing", () => {
    expect(reason(() => new WireTree().apply(patch(1)))).toBe("gap");
    const t = start();
    expect(reason(() => t.apply(patch(3)))).toBe("gap");
    expect(t.ready).toBe(true);
    expect(reason(() => t.apply(patch(1, { op: "remove", id: 2 })))).toBe("stale");
    expect(t.ready).toBe(true);
    expect(t.get(2)).toBeDefined();
  });

  it("copy-on-write: a change copies the node and its ancestors, nothing else, and not the patch", () => {
    const t = start({ immutable: true });
    const before = t.roots;
    const [s1, t2, t4, s5] = [t.get(1), t.get(2), t.get(4), t.get(5)];
    const node = el(6, "Text", [txt(7, "b")]);
    const sent = structuredClone(node);
    t.apply(patch(2, { op: "props", id: 4, set: { tone: "dim" }, unset: [] }, { op: "insert", parent: 5, index: 0, node }, { op: "text", id: 7, text: "c" }));
    expect(t.roots).not.toBe(before);
    expect(t.get(1)).not.toBe(s1);
    expect(t.get(4)).not.toBe(t4);
    expect(t.get(5)).not.toBe(s5);
    expect(t.get(2)).toBe(t2);
    expect(node).toEqual(sent);
    expect(ids(before)).toEqual([[1, [[2, ["a"]], [4, []], [5, []]]]]);
  });

  it("a dropped node keeps a stand-in that moves and goes; ops inside it, or on its props or words, are ignored", () => {
    const stand = (id: number): TreeNode => ({ id, type: "#text", text: "" });
    const t = start({
      immutable: true,
      adopt: (n, _, drop) => (bad(n) ? (drop(n), stand(n.id)) : n),
    });
    t.apply(patch(2, { op: "insert", parent: 1, index: 0, node: el(10, "Bad", [el(11, "Text", [txt(12, "x")])]) }));
    expect(ids(t.roots)).toEqual([[1, ["", [2, ["a"]], [4, []], [5, []]]]]);
    t.apply(
      patch(3, { op: "props", id: 10, set: { a: 1 }, unset: [] }, { op: "text", id: 12, text: "y" }, { op: "insert", parent: 11, index: 0, node: txt(13, "z") }, { op: "move", id: 12, parent: 11, index: 0 }, { op: "remove", id: 11 }, { op: "move", id: 10, parent: 1, index: 3 }),
    );
    expect(ids(t.roots)).toEqual([[1, [[2, ["a"]], [4, []], [5, []], ""]]]);
    // A live node moved into a dropped one is dropped too.
    t.apply(patch(4, { op: "move", id: 4, parent: 10, index: 0 }, { op: "props", id: 4, set: { a: 1 }, unset: [] }));
    expect(ids(t.roots)).toEqual([[1, [[2, ["a"]], [5, []], ""]]]);
    t.apply(patch(5, { op: "remove", id: 10 }));
    expect(ids(t.roots)).toEqual([[1, [[2, ["a"]], [5, []]]]]);
    expect(t.ready).toBe(true);
  });
});

// ── random runs ──────────────────────────────────────────

const OPTS: GenOptions = { containers: ["Stack", "Inline"], words: "Text", props: (_, rnd): Record<string, WireValue> => (rnd() < 0.5 ? { gap: Math.floor(rnd() * 4) } : { grow: rnd() < 0.5, k: `v${Math.floor(rnd() * 9)}` }) };
const SEEDS = 150;
const PATCHES = 40;
/** The tree as data, for comparing. */
const plain = (nodes: readonly TreeNode[]): TreeNode[] => JSON.parse(JSON.stringify(nodes)) as TreeNode[];

/** The ids a patch must copy (copy-on-write): every list it changed, and every node whose props or words it changed, with their ancestors. */
function touched(model: Model, ops: PatchOp[]): Set<number> {
  const out = new Set<number>();
  const add = (id: number) => id && model.chain(id).forEach((x) => out.add(x));
  for (const op of ops) {
    if (op.op === "insert") add(op.parent);
    else if (op.op === "move" || op.op === "remove") add(model.find(op.id)!.parent);
    else add(op.id);
    model.op(op);
    if (op.op === "move") add(op.parent);
  }
  return out;
}

describe("random runs of patches", () => {
  it("in place and copy-on-write both end as the model does, patch by patch", () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const g = new Gen(seed, OPTS);
      const mutable = new WireTree({ adopt: (n) => structuredClone(n) });
      const cow = new WireTree({ immutable: true });
      const first = g.tree();
      mutable.load(structuredClone(first));
      cow.load(structuredClone(first));
      for (let i = 0; i < PATCHES; i++) {
        const p = g.patch();
        mutable.apply(structuredClone(p));
        cow.apply(structuredClone(p));
        expect(plain(mutable.roots), `seed ${seed} patch ${p.rev}`).toEqual(g.model.nodes);
        expect(plain(cow.roots), `seed ${seed} patch ${p.rev}`).toEqual(g.model.nodes);
      }
    }
  });

  it("copy-on-write keeps every node a patch didn't touch, and the tree before it as it was", () => {
    let kept = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const g = new Gen(seed, OPTS);
      const cow = new WireTree({ immutable: true });
      const shadow = new Model();
      const first = g.tree();
      cow.load(structuredClone(first));
      shadow.nodes = structuredClone(first.nodes);
      for (let i = 0; i < PATCHES; i++) {
        const p = g.patch();
        const before = cow.roots;
        const frozen = plain(before);
        const objects = new Map([...cow.nodes()].map((n) => [n.id, n]));
        const copied = touched(shadow, p.ops);
        cow.apply(structuredClone(p));
        expect(plain(before), `seed ${seed} patch ${p.rev}: the tree before changed`).toEqual(frozen);
        for (const [id, n] of objects) {
          const now = cow.get(id);
          if (!now) continue;
          if (copied.has(id)) expect(now, `seed ${seed} patch ${p.rev}: node ${id} not copied`).not.toBe(n);
          else {
            expect(now, `seed ${seed} patch ${p.rev}: node ${id} copied`).toBe(n);
            kept++;
          }
        }
      }
    }
    expect(kept).toBeGreaterThan(1000);
  });

  it("a hook that drops elements ends as the model with a stand-in for each dropped subtree", () => {
    const opts: GenOptions = { ...OPTS, containers: ["Stack", "Bad"], siblingMoves: true };
    const stand = (id: number): TreeNode => ({ id, type: "#text", text: "" });
    const keep = (n: TreeNode, drop: (n: TreeNode) => void): TreeNode => {
      if (bad(n)) return (drop(n), stand(n.id));
      return n.type === "#text" ? { ...n } : { ...n, props: { ...n.props }, children: n.children.map((c) => keep(c, drop)) };
    };
    const mask = (nodes: TreeNode[]): TreeNode[] => nodes.map((n) => (bad(n) ? stand(n.id) : n.type === "#text" ? n : { ...n, children: mask(n.children) }));
    let dropped = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const g = new Gen(seed, opts);
      const t = new WireTree({ immutable: true, adopt: (n, _, drop) => keep(n, drop) });
      t.load(g.tree());
      for (let i = 0; i < PATCHES; i++) {
        const p = g.patch();
        t.apply(p);
        expect(plain(t.roots), `seed ${seed} patch ${p.rev}`).toEqual(mask(g.model.nodes));
      }
      dropped += g.model.all().filter(bad).length;
    }
    expect(dropped).toBeGreaterThan(100);
  });
});
