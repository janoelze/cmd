// A package widget's tree in the renderer (docs/56, "The view"): what its process sent,
// whole (`tree`) and then as patches, applied in order as the core applies them (the
// protocol's WireTree, widget-patch.ts) and checked on the way in. The store keeps nodes
// immutable (a change copies the node and its ancestors), so the view redraws only what a
// patch touched; a patch that doesn't fit (a skipped rev, an unknown node) asks the core
// for the whole tree again (`resync`), the last good tree staying on screen till it comes. Everything outside API 1's allow-list (API_ELEMENTS) is dropped
// here with a warning naming it: an unknown element, a prop the element doesn't take, a
// handler on a prop that isn't one of its events, a URL that isn't https (a Frame's src: a
// page of the package; a Picture's: only a data: image, which the core checked or fetched), markup in
// words, values of the wrong type (the checks are the protocol's, widget-values.ts, run
// against the spec). Pure: no React, no core; tests feed it messages.

import {
  API_ELEMENTS,
  MARKUP,
  PatchError,
  WireTree,
  checkValue,
  isHandler,
  isPackagePage,
  isPictureData,
  type ApiElementSpec,
  type TreeElement,
  type TreeNode,
  type WidgetHostStatus,
  type WidgetPatch,
  type WidgetTree,
  type WireValue,
} from "@cmd/protocol";

export type TreeMessage = WidgetTree | WidgetPatch | WidgetHostStatus;

/** What the view draws: the top-level nodes, the last rev, the process's state. A new object on every change. */
export interface TreeSnapshot {
  nodes: readonly TreeNode[];
  rev: number;
  /** A tree arrived (a later restart keeps it on screen). */
  loaded: boolean;
  /** What the process is doing, as the last status message said (a tree doesn't change it). */
  status: WidgetHostStatus["state"];
  reason: string | undefined;
  /** More about a stop (a load failure's error). */
  detail: string | undefined;
}

export interface TreeStoreOptions {
  /** Ask for the whole tree again (widget.resync). */
  resync: () => void;
  /** Where warnings go (console.warn). */
  warn?: (message: string) => void;
  /** The allow-list: API_ELEMENTS (tests may pass another). */
  elements?: Readonly<Record<string, ApiElementSpec>>;
}

/** Props that hold a URL (none in API 1 but Frame's and Picture's `src`, checked by their own rules). */
const URL_PROPS = new Set(["src", "href", "url"]);
const safeUrl = (s: string) => /^https:\/\/[^\s]+$/i.test(s) || /^http:\/\/localhost(:\d+)?(\/[^\s]*)?$/i.test(s);

/** The allow-list's checks on one element's props. */
export class Sanitizer {
  readonly elements: Readonly<Record<string, ApiElementSpec>>;
  private readonly warn: (m: string) => void;

  constructor(elements: Readonly<Record<string, ApiElementSpec>>, warn: (m: string) => void) {
    this.elements = elements;
    this.warn = warn;
  }

  private drop(type: string, prop: string, why: string): undefined {
    this.warn(`widget: <${type}> prop "${prop}" dropped: ${why}`);
    return undefined;
  }

  /** A prop as it may be drawn, or undefined (warned) when it may not. null unsets. */
  prop(type: string, key: string, v: WireValue): WireValue | undefined {
    const spec = this.elements[type]!;
    if (v === null) return null;
    if (key === "$hidden") {
      if (typeof v === "boolean") return v;
      return this.drop(type, key, "not true or false");
    }
    if (key.startsWith("$")) return this.drop(type, key, "not a prop of the wire");
    if (Object.hasOwn(spec.events, key)) return isHandler(v) ? v : this.drop(type, key, "not a handler");
    const t = Object.hasOwn(spec.props, key) ? spec.props[key]!.type : undefined;
    if (t === undefined) return this.drop(type, key, isHandler(v) ? "a handler on a prop that isn't one of its events" : "not a prop it takes in API 1");
    if (isHandler(v)) return this.drop(type, key, "a handler on a prop that isn't one of its events");
    // A Frame's page is a file of the package (main serves it from there), not a URL.
    if (type === "Frame" && key === "src") return isPackagePage(v) ? v : this.drop(type, key, "not an .html file of the package");
    // A Picture's never loads from the network here: the core puts the data: URL of what it fetched in its place.
    if (type === "Picture" && key === "src") return isPictureData(v) ? v : this.drop(type, key, "not a data: PNG, JPEG, WebP or GIF (cmd fetches an https picture itself)");
    if (URL_PROPS.has(key)) {
      if (typeof v !== "string" || !safeUrl(v)) return this.drop(type, key, "a URL that isn't https");
      return v;
    }
    const c = checkValue(t, v);
    if (!c.ok) return this.drop(type, key, c.why);
    return c.value;
  }

  props(type: string, props: Record<string, WireValue>): Record<string, WireValue> {
    const out: Record<string, WireValue> = {};
    for (const [k, v] of Object.entries(props)) {
      const s = this.prop(type, k, v);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }

  /**
   * A node from the wire as it may be drawn. What may not (an unknown element and its
   * subtree, a text with markup, a child its parent can't hold) is warned about, passed to
   * `dropped`, and kept as a placeholder (an empty text, drawn as nothing) so the indexes
   * of later patches still line up.
   */
  node(n: TreeNode, parent: string, dropped: (n: TreeNode) => void): TreeNode {
    const drop = (why: string): TreeNode => {
      this.warn(why);
      dropped(n);
      return placeholder(n.id);
    };
    if (n.type === "#text") {
      if (typeof n.text !== "string") return drop(`widget: a text in <${parent}> dropped: not a string`);
      // Blanked, not gone: a later `text` op may set words that are fine.
      if (MARKUP.test(n.text)) return (this.warn(`widget: a text in <${parent}> dropped: markup in text`), placeholder(n.id));
      return { id: n.id, type: "#text", text: n.text };
    }
    const spec = this.elements[n.type];
    if (!spec) return drop(`widget: <${String(n.type)}> dropped: not an element of API 1`);
    const children = (n.children ?? []).map((c) => {
      if (this.holds(n.type, c)) return this.node(c, n.type, dropped);
      const kind = spec.children;
      this.warn(`widget: <${n.type}> holds ${kind === "none" ? "nothing" : kind === "text" ? "only text" : "only elements"}: its ${c.type === "#text" ? "text" : `<${c.type}>`} was dropped`);
      dropped(c);
      return placeholder(c.id);
    });
    return { id: n.id, type: n.type, props: this.props(n.type, n.props ?? {}), children };
  }

  /** Whether a child may sit in an element of type `parent` ("root": the top, which holds anything). */
  holds(parent: string, child: TreeNode): boolean {
    if (isPlaceholder(child)) return true;
    const spec = this.elements[parent];
    if (!spec) return true;
    const kind = spec.children;
    const isText = child.type === "#text";
    return !(kind === "none" || (kind === "text" && !isText) || (kind === "elements" && isText));
  }
}

/** What stands in for a dropped node: nothing to draw, but it keeps its place. */
const placeholder = (id: number): TreeNode => ({ id, type: "#text", text: "" });
const isPlaceholder = (n: TreeNode) => n.type === "#text" && n.text === "";

/** One window's tree. */
export class TreeStore {
  private snap: TreeSnapshot = { nodes: [], rev: 0, loaded: false, status: "starting", reason: undefined, detail: undefined };
  /** The tree as the patches leave it: copy-on-write, sanitised on the way in (protocol widget-patch.ts). */
  private readonly tree: WireTree;
  /** A resync was asked for: patches wait for the tree. */
  private resyncing = false;
  private readonly listeners = new Set<() => void>();
  private readonly opts: TreeStoreOptions;
  private readonly clean: Sanitizer;
  private readonly warn: (m: string) => void;

  constructor(opts: TreeStoreOptions) {
    this.opts = opts;
    this.warn = opts.warn ?? ((m) => console.warn(m));
    this.clean = new Sanitizer(opts.elements ?? API_ELEMENTS, this.warn);
    const typeOf = (parent: TreeElement | null) => (parent ? String(parent.type) : "root");
    this.tree = new WireTree({
      immutable: true,
      adopt: (n, parent, drop) => {
        const type = typeOf(parent);
        if (this.clean.holds(type, n)) return this.clean.node(n, type, drop);
        this.warn(`widget: <${type}> can't hold a ${n.type === "#text" ? "text" : `<${String(n.type)}>`}: dropped`);
        drop(n);
        return placeholder(n.id);
      },
      props: (el, set) => this.clean.props(el.type, set),
      text: (_, text, parent) => {
        if (typeof text === "string" && !MARKUP.test(text)) return text;
        this.warn(`widget: a text in <${typeOf(parent)}> dropped: markup in text`);
        return "";
      },
    });
  }

  get snapshot(): TreeSnapshot {
    return this.snap;
  }

  /** For useSyncExternalStore. */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = (): TreeSnapshot => this.snap;

  get(id: number): TreeNode | undefined {
    return this.tree.get(id);
  }

  apply(m: TreeMessage): void {
    if (m.kind === "status") {
      this.set({ status: m.state, reason: m.reason, detail: m.detail });
    } else if (m.kind === "tree") {
      this.resyncing = false;
      this.tree.load(m);
      // The status stays as last told: a stopped process's last tree comes after its status on resync.
      this.set({ nodes: this.tree.roots, rev: m.rev, loaded: true });
    } else if (m.kind === "patch") {
      if (this.resyncing) return; // waiting for the tree
      try {
        this.tree.apply(m);
      } catch (err) {
        if (!(err instanceof PatchError)) throw err;
        if (err.reason !== "stale") this.lose(); // the last good tree stays on screen until the whole one comes
        return;
      }
      this.set({ nodes: this.tree.roots, rev: m.rev });
    }
  }

  /** Ask for the tree again, once until it comes. */
  private lose(): void {
    if (this.resyncing) return;
    this.resyncing = true;
    this.opts.resync();
  }

  /** Asks for the whole tree (a view mounted after it was sent). */
  resync(): void {
    this.resyncing = true;
    this.opts.resync();
  }

  private set(change: Partial<TreeSnapshot>): void {
    this.snap = { ...this.snap, ...change };
    for (const fn of [...this.listeners]) fn();
  }
}
