// @vitest-environment happy-dom
// API 1.3's display pieces in the package view (docs/57 A6–A10, entries-1.3-display.tsx): a
// Dial typed into keeps its draft here and sends it only on Return (Escape and leaving put the
// value back); a Window's menuLabel names the title menu's button; Return in a
// ToolbarSearchField sends onSubmit; a Stat draws its trend as the kit's Delta and holds a
// Sparkline; a Sparkline takes its series' colour; a chart's delta and note draw the header the
// Stats window's detail has; `reveal` scrolls a row or an entry into view once per change.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppWindow, TreeElement, TreeNode, WireValue } from "@cmd/protocol";
import { ChartHead, ChartSummary, Delta, Sparkline } from "@cmd/ui";
import { createHost, render } from "@cmd/widget-api/testing";
import Countdown from "@cmd/widget-api/examples/v1/countdown.tsx";

vi.mock("../src/renderer/src/lib/bridge.ts", () => ({ cmd: new Proxy({}, { get: () => () => new Promise(() => {}) }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { PackageWidget } = await import("../src/renderer/src/windows/package/PackageView.tsx");
const { TreeStore } = await import("../src/renderer/src/windows/package/tree.ts");
const { chromeOf } = await import("../src/renderer/src/windows/package/chrome.ts");
await import("../src/renderer/src/windows/package/register.tsx");
const { viewFor } = await import("../src/renderer/src/windows/registry.ts");
type Link = import("../src/renderer/src/windows/package/live.ts").WidgetLink;

let root: Root | null = null;
let el: HTMLElement;
const scrolled = vi.fn();
beforeEach(() => {
  // happy-dom lays nothing out: a sparkline needs a width, and scrollIntoView is a spy.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 200 });
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, writable: true, value: scrolled });
  scrolled.mockClear();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function link(): Link & { interact: ReturnType<typeof vi.fn> } {
  return { interact: vi.fn(), resync: vi.fn(), restart: vi.fn(), ask: vi.fn(), env: vi.fn() } as never;
}

async function draw(store: InstanceType<typeof TreeStore>, l: Link = link()) {
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el, { onCaughtError: () => {}, onRecoverableError: () => {} });
  await act(async () => root!.render(<PackageWidget windowId="w-1" store={store} link={l} />));
}

let ids = 1;
const e = (type: string, props: Record<string, WireValue> = {}, ...children: (TreeNode | string)[]): TreeElement => ({
  id: ids++,
  type: type as never,
  props,
  children: children.map((c) => (typeof c === "string" ? { id: ids++, type: "#text", text: c } : c)),
});
const h = (n: number): WireValue => ({ $handler: n });
async function drawTree(...nodes: TreeNode[]) {
  const store = new TreeStore({ resync: () => {} });
  store.apply({ kind: "tree", rev: 1, nodes });
  const l = link();
  await draw(store, l);
  return { store, l };
}

/** Types into an input as a person does (React reads the native value setter). */
function type(input: HTMLInputElement, text: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const key = (input: HTMLElement, k: string) => input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

describe("Dial (A6)", () => {
  async function countdown() {
    const host = createHost({});
    const tree = await render(<Countdown />, host);
    const store = new TreeStore({ resync: () => {} });
    store.apply({ kind: "tree", rev: 1, nodes: tree.nodes });
    const l = link();
    await draw(store, l);
    const value = () => el.querySelector(".ui-dial-value") as HTMLElement;
    const open = async () => {
      await act(async () => value().click());
      return el.querySelector("input.ui-dial-value") as HTMLInputElement;
    };
    return { host, tree, l, value, open };
  }

  it("types a length into the ring: the draft stays here, Return sends it as onSubmit, and the process sets it", async () => {
    const { host, tree, l, value, open } = await countdown();
    expect(value().textContent).toBe("25:00");
    const input = await open();
    expect(input.value).toBe("25:00");
    await act(async () => type(input, "10"));
    // Typing sends nothing: the draft is the renderer's.
    expect(l.interact).not.toHaveBeenCalled();
    await act(async () => key(input, "Enter"));
    const handler = (tree.find("Dial")!.props.onSubmit as { $handler: number }).$handler;
    expect(l.interact).toHaveBeenCalledExactlyOnceWith(handler, "onSubmit", "10");
    expect(el.querySelector("input.ui-dial-value")).toBeNull();
    await act(async () => host.deliver({ kind: "interaction", handler, event: "onSubmit", value: "10" }));
    await tree.idle();
    expect(tree.find("Dial")!.props.value).toBe("10:00");
    tree.unmount();
  });

  it("puts the value back and sends nothing on Escape, and on leaving the field", async () => {
    const { tree, l, value, open } = await countdown();
    let input = await open();
    await act(async () => type(input, "90s"));
    await act(async () => key(input, "Escape"));
    expect(el.querySelector("input.ui-dial-value")).toBeNull();
    expect(value().textContent).toBe("25:00");

    input = await open();
    expect(input.value).toBe("25:00");
    await act(async () => type(input, "1:30"));
    await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(el.querySelector("input.ui-dial-value")).toBeNull();
    expect(value().textContent).toBe("25:00");
    expect(l.interact).not.toHaveBeenCalled();
    tree.unmount();
  });

  it("draws the ring in its tone, and isn't a button without `editable`", async () => {
    await drawTree(e("View", {}, e("Dial", { label: "Time", value: "0:00", progress: 1, tone: "needs", caption: "done at 14:32" })));
    expect(el.querySelector(".ui-dial")!.getAttribute("data-tone")).toBe("needs");
    expect((el.querySelector(".ui-dial-value") as HTMLButtonElement).disabled).toBe(true);
    expect(el.querySelector(".ui-dial-caption")!.textContent).toBe("done at 14:32");
    expect(el.querySelector(".ui-dial-fill")!.getAttribute("stroke-dasharray")).toBe("100 100");
  });
});

describe("Window menuLabel and ToolbarSearchField onSubmit (A7)", () => {
  const win = { id: "w-1", kind: "pkg:test/test", state: {} } as unknown as AppWindow;

  it("names the title menu's button; without one, the checked entry does", async () => {
    const menu = [
      { label: "Agents", checked: true, run: h(1) },
      { label: "Commands", run: h(2) },
    ];
    const { store } = await drawTree(e("Window", { menuLabel: "3 hidden", menu }, e("View", {})));
    expect(chromeOf("w-1")?.menuLabel).toBe("3 hidden");
    expect(viewFor("package")!.titleMenu!(win)?.label).toBe("3 hidden");
    const node = store.snapshot.nodes[0] as TreeElement;
    await act(async () => store.apply({ kind: "patch", rev: 2, ops: [{ op: "props", id: node.id, set: {}, unset: ["menuLabel"] }] }));
    expect(viewFor("package")!.titleMenu!(win)?.label).toBe("Agents");
  });

  it("sends Return in the filter as onSubmit with the text, after the text itself", async () => {
    const { l } = await drawTree(e("View", {}, e("WindowToolbar", { label: "Filter" }, e("ToolbarSearchField", { value: "", placeholder: "Filter", onChange: h(1), onSubmit: h(2) }))));
    const input = el.querySelector(".ui-tb-search input") as HTMLInputElement;
    await act(async () => type(input, "pnpm"));
    await act(async () => key(input, "Enter"));
    expect(l.interact.mock.calls).toEqual([
      [1, "onChange", "pnpm"],
      [2, "onSubmit", "pnpm"],
    ]);
  });

  it("sends nothing on Return without onSubmit", async () => {
    const { l } = await drawTree(e("View", {}, e("WindowToolbar", { label: "Filter" }, e("ToolbarSearchField", { value: "", onChange: h(1) }))));
    const input = el.querySelector(".ui-tb-search input") as HTMLInputElement;
    await act(async () => key(input, "Enter"));
    expect(l.interact).not.toHaveBeenCalled();
  });
});

describe("Stat and Sparkline (A8)", () => {
  it("draws the change as the kit's Delta by trend and good, and the Sparkline inside the tile", async () => {
    await drawTree(
      e(
        "View",
        {},
        e("Stat", { label: "Agent time", value: "9h 15m", delta: "+18%", trend: "up", good: "up" }, e("Sparkline", { values: [1, 3, 2, 5], color: "current" })),
        e("Stat", { label: "Waiting", value: "6m", delta: "−8%", trend: "up", good: "down" }),
        e("Stat", { label: "Turns", value: 412, delta: "±0%", trend: "flat", good: "up" }),
        e("Stat", { label: "p95", value: 412, delta: "+12%", deltaTone: "danger" }),
      ),
    );
    const [time, waiting, turns, p95] = [...el.querySelectorAll(".ui-stat")];
    // The same markup the Stats window's tile has: a Delta inside the stat's delta.
    expect(time!.querySelector(".ui-stat-delta")!.innerHTML).toBe(renderToStaticMarkup(<Delta text="+18%" trend="up" good="up" />));
    expect(time!.querySelector(".ui-delta")!.textContent).toBe("▲ 18%");
    expect(time!.querySelector(".ui-sparkline svg")).not.toBeNull();
    expect(waiting!.querySelector(".ui-delta")!.getAttribute("data-tone")).toBe("danger");
    expect(turns!.querySelector(".ui-delta")!.getAttribute("data-tone")).toBeNull();
    // Without a trend, the 1.0 text in its tone.
    expect(p95!.querySelector(".ui-delta")).toBeNull();
    expect(p95!.querySelector(".ui-stat-delta")!.getAttribute("data-tone")).toBe("danger");
    expect(p95!.querySelector(".ui-stat-delta")!.textContent).toBe("+12%");
  });

  it("draws a Sparkline in the chart palette's nth colour, as the kit's own", async () => {
    const values = [3, 5, 4, 8, 6];
    await drawTree(e("View", {}, ...[0, 1, 2, 5].map((series) => e("Sparkline", { values, series }))));
    const strokes = [...el.querySelectorAll(".ui-spark-line")].map((p) => p.getAttribute("stroke"));
    expect(strokes).toEqual(["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-6)"]);
    const host = document.createElement("div");
    document.body.append(host);
    const kit = createRoot(host);
    await act(async () => kit.render(<Sparkline values={values} series={1} />));
    expect(el.querySelectorAll(".ui-sparkline")[1]!.outerHTML).toBe(host.firstElementChild!.outerHTML);
    await act(async () => kit.unmount());
  });
});

describe("a chart's delta and note (A9)", () => {
  const chart = (type: "TimeBars" | "TimeSeries", more: Record<string, WireValue>) =>
    e(type, { buckets: [0, 1, 2], series: [{ key: "t", label: "Agent time", values: [1, 2, 3] }], labels: ["M", "T", "W"], unit: "ms", label: "Agent time", summary: "9h 15m", ...more });

  it("draws the header the Stats window's detail has: the value bold, a Delta, the note", async () => {
    await drawTree(e("View", {}, chart("TimeBars", { delta: { text: "+11%", trend: "up", good: "up" }, note: "median 4m, 90% under 12m" }), chart("TimeSeries", { delta: { text: "4%", trend: "down" } })));
    const [bars, series] = [...el.querySelectorAll(".ui-chart-head")];
    expect(bars!.outerHTML).toBe(renderToStaticMarkup(<ChartHead summary={<ChartSummary value="9h 15m" delta={<Delta text="+11%" trend="up" good="up" />} note="median 4m, 90% under 12m" />} />));
    expect(series!.querySelector("b.ui-chart-value")!.textContent).toBe("9h 15m");
    expect(series!.querySelector(".ui-delta")!.textContent).toBe("▼ 4%");
  });

  it("keeps a plain summary without them", async () => {
    await drawTree(e("View", {}, chart("TimeBars", {})));
    expect(el.querySelector(".ui-chart-head")!.innerHTML).toBe("9h 15m");
  });
});

describe("reveal (A10)", () => {
  it("scrolls a row into view when it becomes true, once per change, not on every redraw", async () => {
    const rowA = e("ListRow", { reveal: false }, e("ListRowContent", { title: "A" }));
    const rowB = e("ListRow", {}, e("ListRowContent", { title: "B" }));
    const { store } = await drawTree(e("View", {}, e("List", {}, rowA, rowB)));
    expect(scrolled).not.toHaveBeenCalled();
    const patch = async (id: number, set: Record<string, WireValue>, rev: number) => act(async () => store.apply({ kind: "patch", rev, ops: [{ op: "props", id, set, unset: [] }] }));
    await patch(rowA.id, { reveal: true }, 2);
    expect(scrolled).toHaveBeenCalledExactlyOnceWith({ block: "nearest", behavior: "smooth" });
    expect(scrolled.mock.contexts[0]).toBe(el.querySelectorAll(".ui-list-row")[0]);
    // Redraws of the row (and of the one beside it) with reveal still true scroll nothing.
    await patch(rowA.id, { selected: true }, 3);
    await patch(rowB.id, { dim: true }, 4);
    expect(scrolled).toHaveBeenCalledTimes(1);
    await patch(rowA.id, { reveal: false }, 5);
    await patch(rowA.id, { reveal: true }, 6);
    expect(scrolled).toHaveBeenCalledTimes(2);
  });

  it("scrolls a TimelineEntry into view the same way", async () => {
    const entry = e("TimelineEntry", { time: "14:05", hue: 200 }, e("Text", {}, "Merged"));
    const { store } = await drawTree(e("View", {}, e("Timeline", {}, entry)));
    await act(async () => store.apply({ kind: "patch", rev: 2, ops: [{ op: "props", id: entry.id, set: { reveal: true, picked: true }, unset: [] }] }));
    await act(async () => store.apply({ kind: "patch", rev: 3, ops: [{ op: "props", id: entry.id, set: { label: "Merged" }, unset: [] }] }));
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(el.querySelector(".ui-tl-entry"));
  });
});
