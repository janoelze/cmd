// A package widget's tree in the renderer (windows/package/tree.ts, docs/56): each patch
// op applies, a skipped rev asks for the whole tree, and everything outside API 1's
// allow-list is dropped on the way in with a warning naming the element (and the prop).
import { describe, expect, it, vi } from "vitest";
import type { ApiElementSpec, TreeElement, TreeNode, WidgetTree, WireValue } from "@cmd/protocol";
import { API_ELEMENTS } from "@cmd/protocol";
import { TreeStore, type TreeStoreOptions } from "../src/renderer/src/windows/package/tree.ts";

const el = (id: number, type: string, props: Record<string, WireValue> = {}, children: TreeNode[] = []) => ({ id, type, props, children }) as TreeElement;
const txt = (id: number, text: string): TreeNode => ({ id, type: "#text", text });
const tree = (nodes: TreeNode[], rev = 1): WidgetTree => ({ kind: "tree", rev, nodes });

function store(opts: Partial<TreeStoreOptions> = {}) {
  const warnings: string[] = [];
  const resync = vi.fn();
  const s = new TreeStore({ resync, warn: (m) => warnings.push(m), ...opts });
  return { s, warnings, resync };
}

/** Rows of a list, by their title. */
function list(): TreeNode[] {
  return [
    el(1, "List", {}, [
      el(2, "ListRow", { onClick: { $handler: 1 } }, [el(3, "ListRowContent", { title: "Tours" })]),
      el(4, "ListRow", {}, [el(5, "ListRowContent", { title: "Perf" })]),
    ]),
  ];
}
const titles = (s: TreeStore) => ((s.snapshot.nodes[0] as TreeElement).children as TreeElement[]).map((r) => (r.children?.[0] as TreeElement | undefined)?.props.title ?? `#${r.id}`);

describe("patches", () => {
  it("applies a tree, then insert, move, remove, props and text in order", () => {
    const { s, resync } = store();
    s.apply(tree(list()));
    expect(s.snapshot.loaded).toBe(true);
    expect(titles(s)).toEqual(["Tours", "Perf"]);

    s.apply({ kind: "patch", rev: 2, ops: [{ op: "insert", parent: 1, index: 1, node: el(6, "ListRow", {}, [el(7, "ListRowContent", { title: "Docs" })]) }] });
    expect(titles(s)).toEqual(["Tours", "Docs", "Perf"]);

    s.apply({ kind: "patch", rev: 3, ops: [{ op: "move", id: 4, parent: 1, index: 0 }] });
    expect(titles(s)).toEqual(["Perf", "Tours", "Docs"]);

    s.apply({ kind: "patch", rev: 4, ops: [{ op: "remove", id: 2 }] });
    expect(titles(s)).toEqual(["Perf", "Docs"]);
    expect(s.get(3)).toBeUndefined();

    s.apply({ kind: "patch", rev: 5, ops: [{ op: "props", id: 7, set: { title: "Docs site", detail: "Building" }, unset: [] }, { op: "props", id: 7, set: {}, unset: ["detail"] }] });
    expect((s.get(7) as TreeElement).props).toEqual({ title: "Docs site" });

    s.apply({ kind: "patch", rev: 6, ops: [{ op: "insert", parent: 0, index: 1, node: el(8, "Text", {}, [txt(9, "3 agents")]) }] });
    s.apply({ kind: "patch", rev: 7, ops: [{ op: "text", id: 9, text: "4 agents" }] });
    expect(((s.snapshot.nodes[1] as TreeElement).children[0] as { text: string }).text).toBe("4 agents");
    expect(s.snapshot.rev).toBe(7);
    expect(resync).not.toHaveBeenCalled();
  });

  it("copies only what a patch touched: other rows keep their identity", () => {
    const { s } = store();
    s.apply(tree(list()));
    const before = s.snapshot;
    const perf = s.get(4);
    s.apply({ kind: "patch", rev: 2, ops: [{ op: "props", id: 2, set: { selected: true }, unset: [] }] });
    expect(s.snapshot).not.toBe(before);
    expect(s.get(4)).toBe(perf);
    expect(s.get(2)).not.toBe((before.nodes[0] as TreeElement).children[0]);
  });

  it("asks for the tree again on a rev gap, once, and ignores patches until it comes", () => {
    const { s, resync } = store();
    s.apply(tree(list()));
    s.apply({ kind: "patch", rev: 3, ops: [{ op: "remove", id: 2 }] });
    expect(resync).toHaveBeenCalledTimes(1);
    s.apply({ kind: "patch", rev: 4, ops: [{ op: "remove", id: 4 }] });
    expect(resync).toHaveBeenCalledTimes(1);
    expect(titles(s)).toEqual(["Tours", "Perf"]);
    s.apply(tree(list(), 4));
    s.apply({ kind: "patch", rev: 5, ops: [{ op: "remove", id: 4 }] });
    expect(titles(s)).toEqual(["Tours"]);
    // An old patch is old news, not a gap.
    s.apply({ kind: "patch", rev: 5, ops: [{ op: "remove", id: 2 }] });
    expect(titles(s)).toEqual(["Tours"]);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it("asks for the tree when a patch comes first, or names a node it doesn't have", () => {
    const a = store();
    a.s.apply({ kind: "patch", rev: 1, ops: [] });
    expect(a.resync).toHaveBeenCalledTimes(1);
    const b = store();
    b.s.apply(tree(list()));
    b.s.apply({ kind: "patch", rev: 2, ops: [{ op: "remove", id: 99 }] });
    expect(b.resync).toHaveBeenCalledTimes(1);
  });

  it("keeps the process's state, and the last tree through a restart", () => {
    const { s } = store();
    s.apply(tree(list()));
    s.apply({ kind: "status", state: "stopped", reason: "crashed" });
    expect(s.snapshot).toMatchObject({ status: "stopped", reason: "crashed", loaded: true });
    s.apply({ kind: "status", state: "starting" });
    expect(titles(s)).toEqual(["Tours", "Perf"]);
    s.apply({ kind: "status", state: "running" });
    s.apply(tree(list(), 1));
    expect(s.snapshot.status).toBe("running");
  });

  it("keeps a stopped status through the tree that follows it (a resync sends the status, then the last tree)", () => {
    const { s } = store();
    s.apply({ kind: "status", state: "stopped", reason: "crashed" });
    s.apply(tree(list(), 3));
    expect(s.snapshot).toMatchObject({ status: "stopped", reason: "crashed", loaded: true, rev: 3 });
  });
});

describe("the allow-list", () => {
  it("drops an element that isn't in API 1, naming it, and keeps the rest", () => {
    const { s, warnings } = store();
    s.apply(tree([el(1, "Stack", {}, [el(2, "iframe" as never, { src: "https://x" }, [el(3, "Text")]), el(4, "Text", {}, [txt(5, "kept")])])]));
    expect(warnings).toEqual(["widget: <iframe> dropped: not an element of API 1"]);
    const stack = s.snapshot.nodes[0] as TreeElement;
    expect(stack.children.map((c) => c.type)).toEqual(["#text", "Text"]);
    // Its place is kept, so later indexes line up; ops on it or inside it do nothing.
    s.apply({ kind: "patch", rev: 2, ops: [{ op: "insert", parent: 1, index: 2, node: el(6, "Badge", {}, [txt(7, "new")]) }, { op: "props", id: 2, set: { x: 1 }, unset: [] }, { op: "remove", id: 3 }] });
    expect((s.snapshot.nodes[0] as TreeElement).children.map((c) => c.type)).toEqual(["#text", "Text", "Badge"]);
  });

  it("drops a prop the element doesn't take", () => {
    const { s, warnings } = store();
    s.apply(tree([el(1, "Button", { variant: "primary", className: "x", style: { color: "red" } }, [txt(2, "Go")])]));
    expect((s.snapshot.nodes[0] as TreeElement).props).toEqual({ variant: "primary" });
    expect(warnings).toEqual(['widget: <Button> prop "className" dropped: not a prop it takes in API 1', 'widget: <Button> prop "style" dropped: not a prop it takes in API 1']);
  });

  it("drops a handler on a prop that isn't one of the element's events", () => {
    const { s, warnings } = store();
    s.apply(tree([el(1, "Text", { onClick: { $handler: 4 }, tone: { $handler: 5 } }, [txt(2, "hi")]), el(3, "Button", { onClick: { $handler: 6 } })]));
    expect((s.snapshot.nodes[0] as TreeElement).props).toEqual({});
    expect((s.snapshot.nodes[1] as TreeElement).props).toEqual({ onClick: { $handler: 6 } });
    expect(warnings).toEqual(['widget: <Text> prop "onClick" dropped: a handler on a prop that isn\'t one of its events', 'widget: <Text> prop "tone" dropped: a handler on a prop that isn\'t one of its events']);
  });

  it("drops a URL that isn't https (or http://localhost)", () => {
    const elements: Record<string, ApiElementSpec> = { ...API_ELEMENTS, Picture: { props: { src: "string", alt: "string" }, events: [], children: "none" } };
    const { s, warnings } = store({ elements });
    s.apply(tree([el(1, "Picture" as never, { src: "http://example.com/a.png" }), el(2, "Picture" as never, { src: "javascript:alert(1)" }), el(3, "Picture" as never, { src: "https://example.com/a.png" }), el(4, "Picture" as never, { src: "http://localhost:3000/a.png" })]));
    expect(s.snapshot.nodes.map((n) => (n as TreeElement).props.src)).toEqual([undefined, undefined, "https://example.com/a.png", "http://localhost:3000/a.png"]);
    expect(warnings).toEqual(['widget: <Picture> prop "src" dropped: a URL that isn\'t https', 'widget: <Picture> prop "src" dropped: a URL that isn\'t https']);
  });

  it("drops markup in words: texts, string props, menu labels", () => {
    const { s, warnings } = store();
    s.apply(tree([el(1, "Text", {}, [txt(2, "<img src=x onerror=alert(1)>")]), el(3, "ListRowContent", { title: "a < b", detail: "</div>" }), el(4, "Window", { menu: [{ label: "<b>x</b>" }] })]));
    expect(((s.snapshot.nodes[0] as TreeElement).children[0] as { text: string }).text).toBe("");
    expect((s.snapshot.nodes[1] as TreeElement).props).toEqual({ title: "a < b" });
    expect((s.snapshot.nodes[2] as TreeElement).props).toEqual({});
    expect(warnings).toEqual(["widget: a text in <Text> dropped: markup in text", 'widget: <ListRowContent> prop "detail" dropped: markup in text', 'widget: <Window> prop "menu" dropped: label isn\'t plain text']);
    // A later text that's fine shows.
    s.apply({ kind: "patch", rev: 2, ops: [{ op: "text", id: 2, text: "fine" }] });
    expect(((s.snapshot.nodes[0] as TreeElement).children[0] as { text: string }).text).toBe("fine");
  });

  it("drops a $-prop other than $hidden", () => {
    const { s, warnings } = store();
    s.apply(tree([el(1, "Text", { $hidden: true, $html: "<b>" }, [])]));
    expect((s.snapshot.nodes[0] as TreeElement).props).toEqual({ $hidden: true });
    expect(warnings).toEqual(['widget: <Text> prop "$html" dropped: not a prop of the wire']);
  });

  it("checks values against their types: enums, numbers, menus with run handlers, view states, options", () => {
    const { s, warnings } = store();
    s.apply(
      tree([
        el(1, "Badge", { tone: "purple", size: "md" }),
        el(2, "ListSection", { title: "Waiting", count: "3" }),
        el(3, "ListRow", { menu: [{ label: "Mark Seen", run: { $handler: 2 } }, { separator: true }] }),
        el(4, "ListRow", { menu: [{ label: "Open", run: "() => open()" }] }),
        el(5, "View", { state: { kind: "empty", title: "No agents", action: { label: "Start", run: { $handler: 3 } } } }),
        el(6, "View", { state: { kind: "fancy" } }),
        el(7, "ToolbarSegmented", { value: "a", options: [{ value: "a", label: "A" }], label: "Mode" }),
        el(8, "Sparkline", { values: [1, null, 3] }),
        el(9, "Stack", { gap: 7 }),
      ]),
    );
    const props = s.snapshot.nodes.map((n) => (n as TreeElement).props);
    expect(props[0]).toEqual({ size: "md" });
    expect(props[1]).toEqual({ title: "Waiting" });
    expect(props[2]!.menu).toHaveLength(2);
    expect(props[3]).toEqual({});
    expect(props[4]!.state).toMatchObject({ title: "No agents" });
    expect(props[5]).toEqual({});
    expect(props[6]).toMatchObject({ value: "a", label: "Mode" });
    expect(props[7]).toEqual({ values: [1, null, 3] });
    expect(props[8]).toEqual({});
    expect(warnings).toEqual([
      'widget: <Badge> prop "tone" dropped: "purple" isn\'t one of neutral, accent, success, warning, danger',
      'widget: <ListSection> prop "count" dropped: not a number',
      'widget: <ListRow> prop "menu" dropped: a menu entry\'s run isn\'t a handler',
      'widget: <View> prop "state" dropped: kind "fancy" isn\'t one of empty, loading, noResults, error',
      'widget: <Stack> prop "gap" dropped: 7 isn\'t one of 0, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12',
    ]);
  });

  it("sanitises patches too: inserted nodes and set props", () => {
    const { s, warnings } = store();
    s.apply(tree(list()));
    s.apply({ kind: "patch", rev: 2, ops: [{ op: "props", id: 2, set: { onMouseEnter: { $handler: 9 }, dim: true }, unset: [] }, { op: "insert", parent: 1, index: 0, node: el(10, "script" as never) }] });
    expect(s.get(2)).toMatchObject({ props: { onClick: { $handler: 1 }, dim: true } });
    expect((s.get(2) as TreeElement).props.onMouseEnter).toBeUndefined();
    expect(warnings).toEqual(['widget: <ListRow> prop "onMouseEnter" dropped: a handler on a prop that isn\'t one of its events', "widget: <script> dropped: not an element of API 1"]);
    expect(titles(s)).toEqual(["#10", "Tours", "Perf"]);
  });

  it("drops a child its parent can't hold", () => {
    const { s, warnings } = store();
    s.apply(tree([el(1, "Text", {}, [el(2, "Button")]), el(3, "List", {}, [txt(4, "loose words")])]));
    expect(warnings).toEqual(["widget: <Text> holds only text: its <Button> was dropped", "widget: <List> holds only elements: its text was dropped"]);
  });
});
