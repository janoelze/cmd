// @vitest-environment happy-dom
// A package widget's view (windows/package/PackageView.tsx, docs/56): the example widget's
// tree, made by the real widget runtime against the fake host, drawn with the kit; a click
// on a row reaches the process as the right interaction; a props patch redraws one row;
// an element outside API 1 doesn't stop the rest; a tree that throws shows a Callout; a save
// that doesn't load keeps the last tree under a banner; a waiting widget's Allow… asks again.
// Also times a thousand rows' first draw (the number is in the report of docs/56 item D).
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TreeElement, TreeNode, WidgetOut, WireValue } from "@cmd/protocol";
import { createHost, fixtures, render } from "@cmd/widget-api/testing";
import AgentActivity from "@cmd/widget-api/examples/v1/agents.tsx";

vi.mock("../src/renderer/src/lib/bridge.ts", () => ({ cmd: new Proxy({}, { get: () => () => new Promise(() => {}) }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { PackageWidget } = await import("../src/renderer/src/windows/package/PackageView.tsx");
const { TreeStore } = await import("../src/renderer/src/windows/package/tree.ts");
const { ELEMENTS } = await import("../src/renderer/src/windows/package/elements.tsx");
type Link = import("../src/renderer/src/windows/package/live.ts").WidgetLink;

let root: Root | null = null;
let el: HTMLElement;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function link(over: Partial<Link> = {}): Link & { interact: ReturnType<typeof vi.fn> } {
  return { interact: vi.fn(), resync: vi.fn(), restart: vi.fn(), ask: vi.fn(), env: vi.fn(), ...over } as never;
}

async function draw(store: InstanceType<typeof TreeStore>, l: Link = link()) {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el, { onCaughtError: () => {}, onRecoverableError: () => {} });
  await act(async () => root!.render(<PackageWidget windowId="w-1" store={store} link={l} />));
}

const rows = () => [...el.querySelectorAll(".ui-list-row")] as HTMLElement[];
const titleOf = (r: Element) => r.querySelector(".ui-list-row-title, .ui-list-row-content")?.textContent ?? r.textContent;

const agents = [fixtures.agent({ name: "Tours", state: "waiting" }), fixtures.agent({ name: "Perf", state: "working" }), fixtures.agent({ name: "Docs", state: "done" })];

describe("the package view", () => {
  it("draws the example widget's rows, and a click reaches the process as its row's handler", async () => {
    const host = createHost({ agents });
    const tree = await render(<AgentActivity />, host);
    const store = new TreeStore({ resync: () => {} });
    store.apply({ kind: "tree", rev: 1, nodes: tree.nodes });
    // The way back: the interaction to the process, as the core would forward it.
    const l = link({ interact: vi.fn((handler: number, event: string, value?: WireValue) => host.deliver({ kind: "interaction", handler, event, ...(value === undefined ? {} : { value }) })) });
    await draw(store, l);

    expect(rows().map((r) => r.textContent)).toEqual([expect.stringContaining("Tours"), expect.stringContaining("Perf"), expect.stringContaining("Docs")]);
    expect(el.textContent).toContain("Waiting for you");

    const handler = (tree.rows()[0]!.props.onClick as { $handler: number }).$handler;
    await act(async () => rows()[0]!.click());
    expect(l.interact).toHaveBeenCalledWith(handler, "onClick", undefined);
    await tree.idle();
    expect(host.calls).toEqual([["windows.select", "w-tours"]]);
    tree.unmount();
  });

  it("redraws only the row a props patch touched; the others stay mounted", async () => {
    const host = createHost({ agents });
    const tree = await render(<AgentActivity />, host);
    const store = new TreeStore({ resync: () => {} });
    store.apply({ kind: "tree", rev: 1, nodes: tree.nodes });
    const ListRowContent = ELEMENTS.ListRowContent as ComponentType<never>;
    const drawn = vi.fn();
    (ELEMENTS as Record<string, unknown>).ListRowContent = (p: never) => (drawn(), <ListRowContent {...(p as object)} />);
    try {
      await draw(store);
      const [tours, perf, docs] = rows();
      const content = tree.findAll("ListRowContent", (n) => n.props.title === "Perf")[0]!;
      drawn.mockClear();
      await act(async () => store.apply({ kind: "patch", rev: 2, ops: [{ op: "props", id: content.id, set: { title: "Perf run" }, unset: [] }] }));
      expect(rows()[1]!.textContent).toContain("Perf run");
      expect(rows()[0]).toBe(tours);
      expect(rows()[1]).toBe(perf);
      expect(rows()[2]).toBe(docs);
      expect(drawn).toHaveBeenCalledTimes(1);
    } finally {
      (ELEMENTS as Record<string, unknown>).ListRowContent = ListRowContent;
      tree.unmount();
    }
  });

  it("draws the rest of a tree with an element outside API 1", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new TreeStore({ resync: () => {} });
    const nodes: TreeNode[] = [
      { id: 1, type: "View", props: {}, children: [
        { id: 2, type: "marquee" as never, props: {}, children: [{ id: 3, type: "#text", text: "hello" }] },
        { id: 4, type: "Text", props: {}, children: [{ id: 5, type: "#text", text: "Still here" }] },
      ] } as TreeElement,
    ];
    store.apply({ kind: "tree", rev: 1, nodes });
    await draw(store);
    expect(el.textContent).toContain("Still here");
    expect(el.textContent).not.toContain("hello");
    expect(warn).toHaveBeenCalledWith("widget: <marquee> dropped: not an element of API 1");
  });

  it("shows a Callout when the tree can't be drawn, and draws the next tree", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Badge = ELEMENTS.Badge;
    (ELEMENTS as Record<string, unknown>).Badge = () => {
      throw new Error("kit changed");
    };
    try {
      const store = new TreeStore({ resync: () => {} });
      store.apply({ kind: "tree", rev: 1, nodes: [{ id: 1, type: "View", props: {}, children: [{ id: 2, type: "Badge", props: {}, children: [{ id: 3, type: "#text", text: "new" }] }] }] });
      await draw(store);
      expect(el.querySelector(".ui-callout")?.textContent).toContain("This widget couldn't be drawn");
      expect(el.textContent).toContain("kit changed");
      (ELEMENTS as Record<string, unknown>).Badge = Badge;
      await act(async () => store.apply({ kind: "tree", rev: 2, nodes: [{ id: 4, type: "View", props: {}, children: [{ id: 5, type: "Badge", props: {}, children: [{ id: 6, type: "#text", text: "fixed" }] }] }] }));
      expect(el.querySelector(".ui-callout")).toBeNull();
      expect(el.textContent).toContain("fixed");
    } finally {
      (ELEMENTS as Record<string, unknown>).Badge = Badge;
    }
  });

  it("shows the process's state while there is no tree, and reports where it is drawn", async () => {
    const store = new TreeStore({ resync: () => {} });
    const l = link();
    await draw(store, l);
    expect(el.textContent).toContain("Starting…");
    expect(l.env).toHaveBeenCalledWith({ theme: "dark", size: "regular", box: null, placement: "board", locale: Intl.NumberFormat().resolvedOptions().locale });
    await act(async () => store.apply({ kind: "status", state: "waiting-grant" }));
    expect(el.textContent).toContain("Waiting for permission");
    await act(async () => [...el.querySelectorAll("button")].find((b) => b.textContent === "Allow…")!.click());
    expect(l.ask).toHaveBeenCalledTimes(1); // the grants sheet again
    await act(async () => store.apply({ kind: "status", state: "stopped", reason: "crashed" }));
    expect(el.textContent).toContain("Stopped · crashed");
    await act(async () => [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Restart"))!.click());
    expect(l.restart).toHaveBeenCalledTimes(1);
    expect(l.resync).not.toHaveBeenCalled();
  });

  it("keeps the last tree when a save doesn't load, under a banner with the error and Restart; the next tree clears it", async () => {
    const store = new TreeStore({ resync: () => {} });
    const l = link();
    const tree = (rev: number, text: string): TreeNode[] => [{ id: rev * 10, type: "View", props: {}, children: [{ id: rev * 10 + 1, type: "Text", props: {}, children: [{ id: rev * 10 + 2, type: "#text", text }] }] }];
    store.apply({ kind: "status", state: "running" });
    store.apply({ kind: "tree", rev: 1, nodes: tree(1, "3 rows") });
    await draw(store, l);
    await act(async () => store.apply({ kind: "status", state: "starting" })); // a save restarts it
    expect(el.textContent).toContain("3 rows");
    const detail = "The module's source code could not be parsed: Expected ';' at file:///w/src/main.tsx:2:9";
    await act(async () => store.apply({ kind: "status", state: "stopped", reason: "didn't load", detail }));
    expect(el.textContent).toContain("3 rows"); // the tree stays
    const callout = el.querySelector(".ui-callout[data-tone=danger]");
    expect(callout?.textContent).toContain("Stopped · didn't load");
    expect(callout?.textContent).toContain("Expected ';'");
    await act(async () => [...callout!.querySelectorAll("button")].find((b) => b.textContent?.includes("Restart"))!.click());
    expect(l.restart).toHaveBeenCalledTimes(1);
    await act(async () => {
      store.apply({ kind: "status", state: "running" });
      store.apply({ kind: "tree", rev: 1, nodes: tree(2, "4 rows") });
    });
    expect(el.querySelector(".ui-callout")).toBeNull();
    expect(el.textContent).toContain("4 rows");
  });

  it("says why a widget without a tree didn't load", async () => {
    const store = new TreeStore({ resync: () => {} });
    await draw(store);
    await act(async () => store.apply({ kind: "status", state: "stopped", reason: "didn't load", detail: "Expected ';'" }));
    expect(el.textContent).toContain("Stopped · didn't load");
    expect(el.textContent).toContain("Expected ';'");
  });

  it("draws a thousand rows: a window's worth first, then the rest", async () => {
    const host = createHost({ agents: Array.from({ length: 1000 }, (_, i) => fixtures.agent({ name: `Agent ${i}`, state: i % 3 ? "working" : "waiting" })) });
    const tree = await render(<AgentActivity />, host);
    const messages = host.messages.filter((m): m is Extract<WidgetOut, { kind: "tree" }> => m.kind === "tree");
    expect(messages.length).toBeGreaterThan(0);
    const store = new TreeStore({ resync: () => {} });
    el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<PackageWidget windowId="w-1" store={store} link={link()} />));
    const start = performance.now();
    act(() => store.apply({ kind: "tree", rev: 1, nodes: tree.nodes }));
    const ms = performance.now() - start;
    // A window's worth at once, the rest over the next frames (elements.tsx, useProgressive).
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().length).toBeLessThan(1000);
    // The rest come over frames, as in the app: outside act, which would hold them back.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    try {
      await vi.waitFor(() => expect(rows()).toHaveLength(1000), { timeout: 20_000 });
    } finally {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    }
    const all = performance.now() - start;
    console.info(`widget view: first draw of a 1000-row tree ${ms.toFixed(1)} ms, all rows ${all.toFixed(0)} ms (happy-dom)`);
    // No time asserted: the budget (50 ms) is Electron's, measured by the Workbench's ThousandRows story;
    // happy-dom is slower, and a loaded test run slower still. What's held here is the shape: some rows first, then all.
    tree.unmount();
  }, 30_000);
});
