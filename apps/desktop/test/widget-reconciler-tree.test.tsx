// The reconciler's patches, applied, give the tree it would send whole: a widget whose
// state changes at random (keyed rows shuffled, added and dropped, words and props changed,
// a subtree shown and hidden) runs on the real reconciler; after each commit the renderer's
// store (windows/package/tree.ts) and the core's applier (protocol WireTree, in place on a
// copy, as widgets/host/tree.ts holds it) equal the tree the process sends on `resync`.

import { useState } from "react";
import { describe, expect, it } from "vitest";
import { WireTree, type TreeNode, type WidgetIn, type WidgetTree, type WidgetOut } from "@cmd/protocol";
import { run } from "@cmd/widget-api/runtime";
import { Inline, List, ListRow, ListRowContent, Stack, Text, View } from "@cmd/widget-api";
import { TreeStore } from "../src/renderer/src/windows/package/tree.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const idle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};
const plain = (nodes: readonly TreeNode[]) => JSON.parse(JSON.stringify(nodes)) as TreeNode[];

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Row {
  id: number;
  title: string;
  detail: string | null;
}
interface State {
  rows: Row[];
  chips: number[];
  show: boolean;
  words: string;
  dim: boolean;
  gap: 1 | 2 | 3;
}

function change(s: State, rnd: () => number, next: () => number): State {
  const rows = [...s.rows];
  const chips = [...s.chips];
  const n = 1 + Math.floor(rnd() * 3);
  const out = { ...s, rows, chips };
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const at = Math.floor(rnd() * (rows.length + 1));
    if (r < 0.2) rows.splice(at, 0, { id: next(), title: `row ${Math.floor(rnd() * 50)}`, detail: rnd() < 0.5 ? "d" : null });
    else if (r < 0.35 && rows.length) rows.splice(at % rows.length, 1);
    else if (r < 0.55 && rows.length > 1) rows.sort(() => rnd() - 0.5);
    else if (r < 0.65 && rows.length) rows[at % rows.length] = { ...rows[at % rows.length]!, title: `row ${Math.floor(rnd() * 50)}`, detail: rnd() < 0.5 ? null : "e" };
    else if (r < 0.75) chips.splice(Math.floor(rnd() * (chips.length + 1)), 0, next());
    else if (r < 0.8 && chips.length) chips.splice(Math.floor(rnd() * chips.length), 1);
    else if (r < 0.85 && chips.length > 1) chips.reverse();
    else if (r < 0.9) out.show = !out.show;
    else if (r < 0.95) out.words = `words ${Math.floor(rnd() * 9)}`;
    else {
      out.dim = !out.dim;
      out.gap = ((Math.floor(rnd() * 3) + 1) as State["gap"]);
    }
  }
  return out;
}

describe("the reconciler's patches", () => {
  it("applied by the renderer and the core, equal the whole tree after every commit", async () => {
    const ops = new Set<string>();
    for (let seed = 1; seed <= 15; seed++) {
      const rnd = random(seed);
      let id = 100;
      const next = () => id++;
      let step = () => {};
      function Random() {
        const [s, set] = useState<State>({ rows: [{ id: 1, title: "one", detail: null }, { id: 2, title: "two", detail: "d" }], chips: [3], show: true, words: "words", dim: false, gap: 2 });
        step = () => set((x) => change(x, rnd, next));
        return (
          <View>
            <List>
              {s.rows.map((r) => (
                <ListRow key={r.id}>
                  <ListRowContent title={r.title} detail={r.detail ?? undefined} />
                </ListRow>
              ))}
            </List>
            {s.show && (
              <Stack gap={s.gap}>
                <Text tone={s.dim ? "dim" : undefined}>{s.words}</Text>
                <Inline>
                  {s.chips.map((c) => (
                    <Text key={c} mono>{`chip ${c}`}</Text>
                  ))}
                </Inline>
              </Stack>
            )}
          </View>
        );
      }

      let resyncs = 0;
      const warnings: string[] = [];
      const store = new TreeStore({ resync: () => resyncs++, warn: (m) => warnings.push(m) });
      const core = new WireTree({ adopt: (n) => structuredClone(n) });
      let whole: WidgetTree | null = null;
      let listener: (m: WidgetIn) => void = () => {};
      const transport = {
        send: (m: WidgetOut) => {
          if (m.kind === "tree") {
            whole = m;
            if (resyncing) return;
            core.load(structuredClone(m));
            store.apply(structuredClone(m));
          } else if (m.kind === "patch") {
            for (const op of m.ops) ops.add(op.op);
            core.apply(structuredClone(m));
            store.apply(structuredClone(m));
          }
        },
        listen: (fn: (m: WidgetIn) => void) => ((listener = fn), () => {}),
      };
      let resyncing = false;
      const running = run(transport, Random, { package: "demo", version: "1.0.0", widget: "main" });
      listener({ kind: "ready", env: { version: "0.32.0", api: { major: 1, minor: 1 }, verbs: [], theme: "dark", size: "regular", placement: "board" }, config: {}, state: {} });
      const r = await running;
      await idle();
      for (let i = 0; i < 30; i++) {
        step();
        await idle();
        // The whole tree as the process would send it now: compared before the holders take it (its rev, so later patches follow).
        resyncing = true;
        listener({ kind: "resync" });
        resyncing = false;
        const t = whole as WidgetTree | null;
        expect(t, `seed ${seed} step ${i}`).not.toBeNull();
        expect(plain(store.snapshot.nodes), `renderer, seed ${seed} step ${i}`).toEqual(plain(t!.nodes));
        expect(plain(core.roots), `core, seed ${seed} step ${i}`).toEqual(plain(t!.nodes));
        core.load(structuredClone(t!));
        store.apply(structuredClone(t!));
      }
      expect(resyncs).toBe(0);
      expect(warnings).toEqual([]);
      r.stop();
    }
    expect([...ops].sort()).toEqual(["insert", "move", "props", "remove", "text"]);
  });
});
