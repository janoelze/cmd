// The reconciler and runtime on the raw wire: what a widget process sends for a tree, a
// state change, a handler, a render error and an unmount, as the core would read it.

import { useEffect, useState } from "react";
import { describe, expect, it } from "vitest";
import type { WidgetIn, WidgetOut, WidgetPatch, WidgetTree, TreeElement } from "@cmd/protocol/widget-tree";
import { run, type Running, type WidgetModule } from "@cmd/widget-api/runtime";
import { Button, List, ListRow, ListRowContent, Text, View, useAgents } from "@cmd/widget-api";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const idle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

/** A widget on an in-memory wire: what it sent, and a way to talk to it as the core. */
async function start(widget: WidgetModule) {
  const sent: WidgetOut[] = [];
  let listener: (m: WidgetIn) => void = () => {};
  const transport = { send: (m: WidgetOut) => void sent.push(m), listen: (fn: (m: WidgetIn) => void) => ((listener = fn), () => {}) };
  const deliver = (m: WidgetIn) => listener(m);
  const running: Promise<Running> = run(transport, widget, { package: "demo", version: "1.0.0", widget: "main" });
  deliver({ kind: "ready", env: { version: "0.32.0", api: { major: 1, minor: 0 }, verbs: [], theme: "dark", size: "regular", placement: "board" }, config: {}, state: {} });
  const r = await running;
  await idle();
  const of = <K extends WidgetOut["kind"]>(kind: K) => sent.filter((m): m is Extract<WidgetOut, { kind: K }> => m.kind === kind);
  return { sent, deliver, r, of };
}

describe("the tree", () => {
  it("says hello with the API, then sends the whole tree once", async () => {
    const { sent, of } = await start(() => (
      <View inset>
        <Text tone="dim">Hello</Text>
      </View>
    ));
    expect(sent[0]).toEqual({ kind: "hello", api: 1, minor: 0, package: "demo", version: "1.0.0", widget: "main" });
    expect(of("tree")).toEqual([
      {
        kind: "tree",
        rev: 1,
        nodes: [{ id: expect.any(Number), type: "View", props: { inset: true }, children: [{ id: expect.any(Number), type: "Text", props: { tone: "dim" }, children: [{ id: expect.any(Number), type: "#text", text: "Hello" }] }] }],
      },
    ]);
    expect(of("patch")).toEqual([]);
  });

  it("sends a state change as a patch of what changed, not a tree", async () => {
    let bump = () => {};
    function Counter() {
      const [n, setN] = useState(0);
      bump = () => setN((x) => x + 1);
      return (
        <View>
          <Text strong={n > 0}>{`Count ${n}`}</Text>
        </View>
      );
    }
    const { of } = await start(Counter);
    const tree = of("tree")[0] as WidgetTree;
    const text = (tree.nodes[0] as TreeElement).children[0] as TreeElement;
    bump();
    await idle();
    expect(of("tree")).toHaveLength(1);
    expect(of("patch")).toEqual([
      {
        kind: "patch",
        rev: 2,
        ops: expect.arrayContaining([
          { op: "props", id: text.id, set: { strong: true }, unset: [] },
          { op: "text", id: text.children[0]!.id, text: "Count 1" },
        ]),
      },
    ]);
    expect((of("patch")[0] as WidgetPatch).ops).toHaveLength(2);
  });

  it("moves keyed rows instead of rebuilding them", async () => {
    let flip = () => {};
    function Rows() {
      const [order, setOrder] = useState(["a", "b", "c"]);
      flip = () => setOrder(["c", "a", "b"]);
      return (
        <List>
          {order.map((k) => (
            <ListRow key={k}>
              <ListRowContent title={k} />
            </ListRow>
          ))}
        </List>
      );
    }
    const { of } = await start(Rows);
    const rows = ((of("tree")[0] as WidgetTree).nodes[0] as TreeElement).children;
    flip();
    await idle();
    const ops = (of("patch")[0] as WidgetPatch).ops;
    expect(ops.every((o) => o.op === "move")).toBe(true);
    // Applied in order, the moves give c, a, b.
    const ids = rows.map((r) => r.id);
    for (const o of ops) if (o.op === "move") ids.splice(o.index, 0, ...ids.splice(ids.indexOf(o.id), 1));
    expect(ids).toEqual([rows[2]!.id, rows[0]!.id, rows[1]!.id]);
  });

  it("answers a resync with the whole tree again", async () => {
    const { of, deliver } = await start(() => <Text>Hi</Text>);
    deliver({ kind: "resync" });
    expect(of("tree").map((t) => t.rev)).toEqual([1, 2]);
  });
});

describe("handlers", () => {
  it("round-trip: an interaction's handler id calls that element's callback", async () => {
    const pressed: string[] = [];
    const { of, deliver } = await start(() => (
      <View>
        <Button onClick={() => pressed.push("one")}>One</Button>
        <Button onClick={() => pressed.push("two")}>Two</Button>
      </View>
    ));
    const [one, two] = ((of("tree")[0] as WidgetTree).nodes[0] as TreeElement).children as TreeElement[];
    expect(one!.props.onClick).toEqual({ $handler: expect.any(Number) });
    deliver({ kind: "interaction", handler: (two!.props.onClick as { $handler: number }).$handler, event: "onClick" });
    deliver({ kind: "interaction", handler: (one!.props.onClick as { $handler: number }).$handler, event: "onClick" });
    expect(pressed).toEqual(["two", "one"]);
  });

  it("keep their id across renders, so a new closure changes nothing on the wire", async () => {
    const seen: number[] = [];
    function Clicker() {
      const [n, setN] = useState(0);
      return (
        <Button
          onClick={() => {
            seen.push(n);
            setN(n + 1);
          }}
        >
          Press
        </Button>
      );
    }
    const { of, deliver } = await start(Clicker);
    const handler = (((of("tree")[0] as WidgetTree).nodes[0] as TreeElement).props.onClick as { $handler: number }).$handler;
    for (let i = 0; i < 3; i++) {
      deliver({ kind: "interaction", handler, event: "onClick" });
      await idle();
    }
    expect(seen).toEqual([0, 1, 2]);
    expect(of("patch")).toEqual([]);
  });

  it("menu entries' runs are handlers too", async () => {
    const chosen: string[] = [];
    const { of, deliver } = await start(() => <ListRow menu={[{ label: "Copy", run: () => chosen.push("copy") }, { separator: true }]} />);
    const menu = ((of("tree")[0] as WidgetTree).nodes[0] as TreeElement).props.menu as { label: string; run: { $handler: number } }[];
    expect(menu[1]).toEqual({ separator: true });
    deliver({ kind: "interaction", handler: menu[0]!.run.$handler, event: "run" });
    expect(chosen).toEqual(["copy"]);
  });
});

describe("errors", () => {
  it("a render error sends error with the stack, draws a Callout, and the process stays up", async () => {
    let fail = () => {};
    function Fragile() {
      const [broken, setBroken] = useState(false);
      fail = () => setBroken(true);
      if (broken) throw new Error("No data for this repo");
      return <Text>Fine</Text>;
    }
    const { of, deliver, r } = await start(Fragile);
    fail();
    await idle();
    const [error] = of("error");
    expect(error).toMatchObject({ kind: "error", message: "No data for this repo" });
    expect(error!.stack).toContain("Fragile");
    expect(error!.componentStack).toContain("Fragile");
    const callout = (of("patch").flatMap((p) => p.ops).find((o) => o.op === "insert" && o.node.type === "Callout") as { node: TreeElement } | undefined)?.node;
    expect(callout?.props).toMatchObject({ tone: "danger" });
    expect(JSON.stringify(callout)).toContain("No data for this repo");
    // Try Again re-renders the widget: still alive.
    const retry = callout!.children.find((c) => c.type === "Button") as TreeElement;
    deliver({ kind: "interaction", handler: (retry.props.onClick as { $handler: number }).$handler, event: "onClick" });
    await idle();
    expect(JSON.stringify(of("patch").at(-1))).toContain("Fine");
    r.stop();
  });

  it("a subscription the core refuses ends, and its hook's widget shows the refusal as a Callout", async () => {
    function Agents() {
      const agents = useAgents();
      return <Text>{`${agents.length} agents`}</Text>;
    }
    const { of, deliver, r } = await start(Agents);
    const sub = of("subscribe")[0]!;
    const message = 'Seeing this workspace needs workspace: ["read"] in package.json\'s cmd.permissions.';
    deliver({ kind: "result", id: sub.id, ok: false, error: { code: "permission", permission: 'workspace: ["read"]', message } });
    await idle();
    const callout = (of("patch").flatMap((p) => p.ops).find((o) => o.op === "insert" && o.node.type === "Callout") as { node: TreeElement } | undefined)?.node;
    expect(callout?.props).toMatchObject({ tone: "danger" });
    expect(JSON.stringify(callout)).toContain("Seeing this workspace needs workspace:");
    expect(of("error")[0]?.message).toBe(message);
    // Ended by the refusal: an event for it now changes nothing.
    const patches = of("patch").length;
    deliver({ kind: "event", sub: sub.id, data: [] });
    await idle();
    expect(of("patch")).toHaveLength(patches);
    r.stop();
  });

  it("a handler that throws is reported, and the widget runs on", async () => {
    const { of, deliver } = await start(() => (
      <Button
        onClick={() => {
          throw new Error("boom");
        }}
      >
        Go
      </Button>
    ));
    const handler = (((of("tree")[0] as WidgetTree).nodes[0] as TreeElement).props.onClick as { $handler: number }).$handler;
    deliver({ kind: "interaction", handler, event: "onClick" });
    expect(of("error")[0]).toMatchObject({ message: "boom", componentStack: null });
  });
});

describe("subscriptions", () => {
  it("a live hook subscribes on mount and unsubscribes on unmount", async () => {
    let hide = () => {};
    function Agents() {
      const agents = useAgents();
      return <Text>{`${agents.length} agents`}</Text>;
    }
    function Shell() {
      const [shown, setShown] = useState(true);
      useEffect(() => void (hide = () => setShown(false)), []);
      return <View>{shown && <Agents />}</View>;
    }
    const { of, deliver } = await start(Shell);
    const [sub] = of("subscribe");
    expect(sub).toEqual({ kind: "subscribe", id: expect.any(Number), topic: "agents", query: {} });
    deliver({ kind: "event", sub: sub!.id, data: [] });
    hide();
    await idle();
    expect(of("unsubscribe")).toEqual([{ kind: "unsubscribe", id: sub!.id }]);
  });

  it("stop() unmounts: every subscription ends and the tree empties", async () => {
    const { of, r } = await start(() => {
      useAgents();
      return <Text>x</Text>;
    });
    r.stop();
    expect(of("unsubscribe")).toHaveLength(1);
    expect(of("patch").at(-1)!.ops).toEqual([{ op: "remove", id: expect.any(Number) }]);
  });
});
