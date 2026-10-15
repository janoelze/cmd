// The three holders of a widget's tree apply patches alike (protocol widget-patch.ts): the
// core's last tree per window (widgets/host/tree.ts), the renderer's store (windows/package/
// tree.ts, copy-on-write and sanitised) and the widget tests' mirror (@cmd/widget-api/testing).
// Random runs of patches over elements API 1 allows (so the renderer drops nothing) end in
// the same tree in all three, and in the plain model's; the core forwards a patch as it came.

import { describe, expect, it } from "vitest";
import type { TreeNode, WidgetPatch, WireValue } from "../packages/protocol/src/widget-tree.ts";
import { Gen, type GenOptions } from "../packages/protocol/test/random-patches.ts";
import { TreeState } from "../packages/core/src/widgets/host/tree.ts";
import { TreeStore } from "../apps/desktop/src/renderer/src/windows/package/tree.ts";
import { Mirror } from "../packages/widget-api/src/testing/tree.ts";

const SPACE = [0, 1, 2, 3];
const OPTS: GenOptions = {
  containers: ["Stack", "Inline"],
  words: "Text",
  props: (type, rnd): Record<string, WireValue> => {
    if (type === "Text") return rnd() < 0.5 ? { tone: "dim" } : { mono: rnd() < 0.5 };
    return rnd() < 0.5 ? { gap: SPACE[Math.floor(rnd() * SPACE.length)]! } : { grow: rnd() < 0.5 };
  },
};
const plain = (nodes: readonly TreeNode[]) => JSON.parse(JSON.stringify(nodes)) as TreeNode[];

function holders() {
  const warnings: string[] = [];
  let resyncs = 0;
  const core = new TreeState();
  const store = new TreeStore({ resync: () => resyncs++, warn: (m) => warnings.push(m) });
  const mirror = new Mirror();
  return { core, store, mirror, warnings, resyncs: () => resyncs };
}

describe("the core, the renderer and the testing mirror", () => {
  it("end in the model's tree after every patch of random runs", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const g = new Gen(seed, OPTS);
      const h = holders();
      const first = g.tree();
      h.core.setTree(structuredClone(first));
      h.store.apply(structuredClone(first));
      h.mirror.apply(structuredClone(first));
      for (let i = 0; i < 40; i++) {
        const p = g.patch();
        // The core forwards the message as it came; the renderer gets what it forwarded.
        const sent = structuredClone(p);
        expect(h.core.apply(p), `seed ${seed} patch ${p.rev}`).toBe(true);
        expect(p, `seed ${seed} patch ${p.rev}: the core changed the message`).toEqual(sent);
        h.store.apply(p);
        h.mirror.apply(structuredClone(p));
        const want = g.model.nodes;
        expect(plain(h.core.tree().nodes), `core, seed ${seed} patch ${p.rev}`).toEqual(want);
        expect(plain(h.store.snapshot.nodes), `renderer, seed ${seed} patch ${p.rev}`).toEqual(want);
        expect(plain(h.mirror.nodes), `mirror, seed ${seed} patch ${p.rev}`).toEqual(want);
      }
      expect(h.warnings).toEqual([]);
      expect(h.resyncs()).toBe(0);
    }
  });

  it("all refuse the same patches (the core and the renderer ask for the tree, the mirror fails the test)", () => {
    const bad: WidgetPatch[] = [
      { kind: "patch", rev: 3, ops: [] },
      { kind: "patch", rev: 2, ops: [{ op: "remove", id: 99 }] },
      { kind: "patch", rev: 2, ops: [{ op: "insert", parent: 1, index: 5, node: { id: 9, type: "Text", props: {}, children: [] } }] },
      { kind: "patch", rev: 2, ops: [{ op: "move", id: 1, parent: 2, index: 0 }] },
    ];
    for (const p of bad) {
      const h = holders();
      const t = { kind: "tree" as const, rev: 1, nodes: [{ id: 1, type: "Stack" as const, props: {}, children: [{ id: 2, type: "Stack" as const, props: {}, children: [] }] }] };
      h.core.setTree(structuredClone(t));
      h.store.apply(structuredClone(t));
      h.mirror.apply(structuredClone(t));
      expect(h.core.apply(p), JSON.stringify(p)).toBe(false);
      h.store.apply(p);
      expect(h.resyncs(), JSON.stringify(p)).toBe(1);
      expect(() => h.mirror.apply(p), JSON.stringify(p)).toThrow(/the renderer would resync/);
    }
  });

  it("the core keeps its own copy: a patch that inserts a subtree and changes it forwards the subtree as sent", () => {
    // Before WireTree the core spliced the sent node into its tree, so a later op of the same
    // patch changed the message it then forwarded: here the renderer would get an insert
    // without node 3 and then a remove of 3, which it doesn't have (a needless resync).
    const h = holders();
    const t = { kind: "tree" as const, rev: 1, nodes: [{ id: 1, type: "Stack" as const, props: {}, children: [] }] };
    h.core.setTree(structuredClone(t));
    h.store.apply(structuredClone(t));
    const p: WidgetPatch = {
      kind: "patch",
      rev: 2,
      ops: [
        { op: "insert", parent: 1, index: 0, node: { id: 2, type: "Text", props: {}, children: [{ id: 3, type: "#text", text: "a" }] } },
        { op: "remove", id: 3 },
      ],
    };
    expect(h.core.apply(p)).toBe(true);
    h.store.apply(p);
    expect(h.resyncs()).toBe(0);
    expect(plain(h.store.snapshot.nodes)).toEqual(plain(h.core.tree().nodes));
  });
});
