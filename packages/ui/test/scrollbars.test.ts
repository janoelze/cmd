// watchScrollbars against a fake document: what scrolls is marked, unmarked after the
// hold, and kept while the pointer rests on its scrollbar or holds the thumb. The page
// side (pageScrollbars) draws, so it's checked in a real browser, not here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollbarScript, SCROLLBAR_CSS, thumbSpan, watchScrollbars } from "../src/scrollbars.ts";

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

describe("thumbSpan", () => {
  it("sizes the thumb to the share in view and moves it with the scroll", () => {
    expect(thumbSpan(300, 300, 3000, 0)).toEqual({ offset: 0, length: 32 }); // never shorter than 32px
    expect(thumbSpan(300, 300, 600, 0)).toEqual({ offset: 0, length: 150 });
    expect(thumbSpan(300, 300, 600, 150)).toEqual({ offset: 75, length: 150 });
    expect(thumbSpan(300, 300, 600, 300)).toEqual({ offset: 150, length: 150 });
    expect(thumbSpan(300, 300, 600, 400).offset).toBe(150); // rubber-banding past the end
  });
});

describe("scrollbarScript", () => {
  it("is the page's thumbs, self-contained", () => {
    const js = scrollbarScript();
    expect(js).toMatch(/^\(function pageScrollbars/);
    expect(js).toContain('"always":false');
    // Runs where there is no window (the guard), so nothing outside its arguments is needed.
    expect(() => new Function("document", js)({ defaultView: null })).not.toThrow();
  });
  it("keeps thumbs shown when scrollbars always show", () => {
    expect(scrollbarScript({ always: true })).toContain('"always":true');
    expect(SCROLLBAR_CSS).toContain("cmd-scrollbars-always");
  });
});
