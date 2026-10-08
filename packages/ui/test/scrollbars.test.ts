// watchScrollbars against a fake document: what scrolls is marked, unmarked after the
// hold, and kept while the pointer rests on its scrollbar or holds the thumb.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollbarScript, SCROLLBAR_CSS, watchScrollbars } from "../src/scrollbars.ts";

type Handler = (e: unknown) => void;

function element(o: { left?: number; top?: number; width?: number; height?: number; client?: number } = {}) {
  const classes = new Set<string>();
  const { left = 0, top = 0, width = 200, height = 100, client = 190 } = o;
  return {
    classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) },
    clientLeft: 0,
    clientTop: 0,
    clientWidth: client,
    clientHeight: height,
    getBoundingClientRect: () => ({ left, top, width, height }),
  };
}

function fakeDocument() {
  const handlers = new Map<string, Handler>();
  const documentElement = element({ width: 800, height: 600, client: 790 });
  const doc = {
    documentElement,
    addEventListener: (type: string, fn: Handler) => handlers.set(type, fn),
  };
  const fire = (type: string, e: unknown) => handlers.get(type)?.(e);
  return { doc, fire };
}

const marked = (el: ReturnType<typeof element>) => el.classList.contains("cmd-scrolling");

describe("watchScrollbars", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("marks what scrolls and unmarks it after the hold", () => {
    const { doc, fire } = fakeDocument();
    watchScrollbars(doc as unknown as Document, 1000);
    const el = element();
    fire("scroll", { target: el });
    expect(marked(el)).toBe(true);
    vi.advanceTimersByTime(900);
    expect(marked(el)).toBe(true);
    fire("scroll", { target: el });
    vi.advanceTimersByTime(900);
    expect(marked(el)).toBe(true); // the hold restarts with every scroll
    vi.advanceTimersByTime(100);
    expect(marked(el)).toBe(false);
  });

  it("marks the root element when the document scrolls", () => {
    const { doc, fire } = fakeDocument();
    watchScrollbars(doc as unknown as Document, 1000);
    fire("scroll", { target: doc });
    expect(marked(doc.documentElement)).toBe(true);
  });

  it("keeps the thumb while the pointer rests on the scrollbar", () => {
    const { doc, fire } = fakeDocument();
    watchScrollbars(doc as unknown as Document, 1000);
    const el = element({ left: 100, top: 50, width: 200, height: 100, client: 190 });
    fire("scroll", { target: el });
    vi.advanceTimersByTime(900);
    fire("pointermove", { clientX: 295, clientY: 80 }); // on the 10px strip at the right edge
    vi.advanceTimersByTime(900);
    expect(marked(el)).toBe(true);
    fire("pointermove", { clientX: 150, clientY: 80 }); // over the content
    vi.advanceTimersByTime(1000);
    expect(marked(el)).toBe(false);
  });

  it("keeps the thumb while it is held, then lets go", () => {
    const { doc, fire } = fakeDocument();
    watchScrollbars(doc as unknown as Document, 1000);
    const el = element();
    fire("scroll", { target: el });
    fire("pointerdown", { clientX: 195, clientY: 50 });
    vi.advanceTimersByTime(5000);
    expect(marked(el)).toBe(true);
    fire("pointerup", {});
    vi.advanceTimersByTime(1000);
    expect(marked(el)).toBe(false);
  });
});

describe("scrollbarScript", () => {
  it("is the watcher, self-contained, for a page", () => {
    const js = scrollbarScript();
    expect(js).toContain("cmd-scrolling");
    expect(js).toMatch(/\(document, \d+\);$/);
    expect(() => new Function(js.replace("(document,", "(({ addEventListener() {}, documentElement: {} }),"))()).not.toThrow();
  });
  it("only marks the page when scrollbars always show", () => {
    expect(scrollbarScript({ always: true })).toContain("cmd-scrollbars-always");
    expect(SCROLLBAR_CSS).toContain("cmd-scrollbars-always");
  });
});
