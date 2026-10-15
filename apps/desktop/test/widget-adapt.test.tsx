// @vitest-environment happy-dom
// Layout by size in a package widget's view (API 1.3, docs/57 A1–A2): an Adapt draws the first
// Case its own box fits and switches as that box resizes, here in the renderer, with nothing
// sent to the widget's process; a Case without conditions is the fallback; an Adapt in a Pane
// reads the pane's box, not the window's. And the box the widget gets (`env.box`): the content's,
// rounded down to 8, at most every 200 ms while it resizes, the last one always. Sizes are faked: a
// ResizeObserver the test drives, and each element's clientWidth/clientHeight from a map.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode, WireValue } from "@cmd/protocol";

vi.mock("../src/renderer/src/lib/bridge.ts", () => ({ cmd: new Proxy({}, { get: () => () => new Promise(() => {}) }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { PackageWidget } = await import("../src/renderer/src/windows/package/PackageView.tsx");
const { TreeStore } = await import("../src/renderer/src/windows/package/tree.ts");
type Link = import("../src/renderer/src/windows/package/live.ts").WidgetLink;

// ── fake sizes ──────────────────────────────────────────

const sizes = new Map<Element, { w: number; h: number }>();
const observers = new Set<{ fn: () => void; els: Set<Element> }>();
class FakeResizeObserver {
  #o: { fn: () => void; els: Set<Element> };
  constructor(fn: () => void) {
    this.#o = { fn, els: new Set() };
    observers.add(this.#o);
  }
  observe(el: Element) {
    this.#o.els.add(el);
  }
  unobserve(el: Element) {
    this.#o.els.delete(el);
  }
  disconnect() {
    observers.delete(this.#o);
  }
}
/** Gives an element a size and tells whoever observes it. */
function resize(el: Element, w: number, h: number) {
  sizes.set(el, { w, h });
  for (const o of [...observers]) if (o.els.has(el)) o.fn();
}

let root: Root | null = null;
let el: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return sizes.get(this)?.w ?? 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return sizes.get(this)?.h ?? 0;
  });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  sizes.clear();
  observers.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── a tree, as data ─────────────────────────────────────

let nextId = 1;
const e = (type: string, props: Record<string, WireValue> = {}, ...children: (TreeNode | string)[]): TreeNode => ({
  id: nextId++,
  type: type as never,
  props,
  children: children.map((c) => (typeof c === "string" ? { id: nextId++, type: "#text", text: c } : c)),
});
const text = (words: string) => e("Text", {}, words);
const faces = () => e("Adapt", {}, e("Case", { maxHeight: 280 }, text("short")), e("Case", { minWidth: 340, minHeight: 440 }, text("large")), e("Case", {}, text("regular")));

function link(): Link & { interact: ReturnType<typeof vi.fn>; env: ReturnType<typeof vi.fn> } {
  return { interact: vi.fn(), resync: vi.fn(), restart: vi.fn(), ask: vi.fn(), env: vi.fn() } as never;
}

async function draw(nodes: TreeNode[], l: Link = link()) {
  el = document.createElement("div");
  document.body.append(el);
  sizes.set(el, { w: 560, h: 432 });
  const store = new TreeStore({ resync: () => {} });
  store.apply({ kind: "tree", rev: 1, nodes });
  root = createRoot(el, { onCaughtError: () => {}, onRecoverableError: () => {} });
  await act(async () => root!.render(<PackageWidget windowId="w-1" store={store} link={l} />));
  return store;
}

const adapts = () => [...el.querySelectorAll(".ui-adapt")];
/** The words of what the nth Adapt draws now. */
const drawn = (n = 0) => adapts()[n]?.textContent;

describe("Adapt in a package widget", () => {
  it("draws the first Case its box fits and switches as it resizes, sending nothing to the process", async () => {
    const l = link();
    await draw([e("View", {}, faces())], l);
    const adapt = adapts()[0]!;
    await act(async () => resize(adapt, 400, 240));
    expect(drawn()).toBe("short");
    const env = l.env.mock.calls.length;

    await act(async () => resize(adapt, 400, 520));
    expect(drawn()).toBe("large");
    expect(adapt.querySelectorAll(".ui-text")).toHaveLength(1); // the other cases aren't mounted
    await act(async () => resize(adapt, 320, 520));
    expect(drawn()).toBe("regular");

    // No round-trip: the switch happened here, nothing went to the widget's process.
    expect(l.interact).not.toHaveBeenCalled();
    expect(l.env.mock.calls.length).toBe(env);
  });

  it("falls back to the Case without conditions, and draws nothing when no Case fits", async () => {
    await draw([e("View", {}, faces(), e("Adapt", {}, e("Case", { minWidth: 1000 }, text("huge"))))]);
    const [first, second] = adapts();
    await act(async () => (resize(first!, 300, 300), resize(second!, 300, 300)));
    expect(drawn(0)).toBe("regular");
    expect(drawn(1)).toBe("");
    await act(async () => resize(second!, 1200, 300));
    expect(drawn(1)).toBe("huge");
  });

  it("reads its own box: in a Pane, the pane's width, whatever the window's", async () => {
    const counts = () => e("Adapt", {}, e("Case", { minWidth: 360 }, text("row")), e("Case", {}, text("column")));
    await draw([e("View", {}, e("Panes", {}, e("Pane", { title: "Today" }, counts()), e("Pane", { title: "Week" }, counts())))]);
    resize(el, 900, 532); // a wide window
    const [today, week] = adapts();
    await act(async () => (resize(today!, 420, 120), resize(week!, 300, 120)));
    expect([drawn(0), drawn(1)]).toEqual(["row", "column"]);
  });

  it("judges new cases (a new tree) against the box it has, without waiting for a resize", async () => {
    const adapt = faces();
    const view = e("View", {}, adapt);
    const store = await draw([view]);
    await act(async () => resize(adapts()[0]!, 400, 520));
    expect(drawn()).toBe("large");
    // The same View and Adapt (their ids), other cases: the Adapt stays mounted and picks again from its box.
    const cases = [e("Case", { minWidth: 600 }, text("wide")), e("Case", { minHeight: 500 }, text("tall"))];
    await act(async () => store.apply({ kind: "tree", rev: 2, nodes: [{ ...view, children: [{ ...adapt, children: cases }] } as TreeNode] }));
    expect(drawn()).toBe("tall");
  });
});

describe("the box a widget gets (env.box)", () => {
  it("is the content's, rounded down to 8, at most every 200 ms while it resizes, the last one always", async () => {
    vi.useFakeTimers();
    const l = link();
    await draw([e("View", {}, text("hi"))], l);
    // Each box the widget was told, once (a size class or theme change sends the same box again).
    const boxes = () => [...new Set(l.env.mock.calls.map((c) => JSON.stringify((c[0] as { box: unknown }).box)))].filter((b) => b !== "null").map((b) => JSON.parse(b));
    expect(boxes()).toEqual([{ width: 560, height: 432 }]);
    expect(l.env.mock.calls.at(-1)![0]).toMatchObject({ size: "regular", box: { width: 560, height: 432 } });

    // A drag: many sizes within 200 ms send one box, the last, when the 200 ms are up.
    await act(async () => resize(el, 501, 403));
    await act(async () => resize(el, 452, 397));
    await act(async () => resize(el, 333, 390));
    expect(boxes()).toHaveLength(1);
    await act(async () => void vi.advanceTimersByTime(200));
    expect(boxes()).toEqual([
      { width: 560, height: 432 },
      { width: 328, height: 384 },
    ]);
    expect(l.env.mock.calls.at(-1)![0]).toMatchObject({ size: "narrow" });

    // A pixel that rounds to the same box sends nothing new.
    await act(async () => void vi.advanceTimersByTime(500));
    await act(async () => resize(el, 334, 391));
    await act(async () => void vi.advanceTimersByTime(500));
    expect(boxes()).toHaveLength(2);
  });
});
