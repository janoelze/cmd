// A package widget's tree in the renderer (docs/56, "The view"): what its process sent,
// whole (`tree`) and then as patches, applied in order and checked on the way in. The
// store keeps nodes immutable (a change copies the node and its ancestors), so the view
// redraws only what a patch touched; a skipped rev asks the core for the whole tree
// again (`resync`). Everything outside API 1's allow-list (API_ELEMENTS) is dropped
// here with a warning naming it: an unknown element, a prop the element doesn't take, a
// handler on a prop that isn't one of its events, a URL that isn't https, markup in
// words, values of the wrong type. Pure: no React, no core; tests feed it messages.

import {
  API_ELEMENTS,
  TREE_ROOT,
  type ApiElementSpec,
  type ApiPropType,
  type HandlerRef,
  type PatchOp,
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

export const isHandler = (v: WireValue | undefined): v is HandlerRef =>
  !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { $handler?: unknown }).$handler === "number" && Object.keys(v).length === 1;

/** `<` before a letter or a slash: a tag, which no word in a widget needs. */
const MARKUP = /<[a-zA-Z/!?]/;
/** Props that hold a URL (none in API 1 yet; Picture's `src` when it comes). */
const URL_PROPS = new Set(["src", "href", "url"]);
const safeUrl = (s: string) => /^https:\/\/[^\s]+$/i.test(s) || /^http:\/\/localhost(:\d+)?(\/[^\s]*)?$/i.test(s);

type Check = { ok: true; value: WireValue } | { ok: false; why: string };
const ok = (value: WireValue): Check => ({ ok: true, value });
const no = (why: string): Check => ({ ok: false, why });

const isObj = (v: WireValue): v is { [key: string]: WireValue } => !!v && typeof v === "object" && !Array.isArray(v);

function words(v: WireValue, numbers: boolean): Check {
  if (typeof v === "number" && numbers) return Number.isFinite(v) ? ok(v) : no("not a finite number");
  if (typeof v !== "string") return no(numbers ? "not text" : "not a string");
  if (MARKUP.test(v)) return no("markup in text");
  return ok(v);
}

/** Optional string fields of an object: each a string without markup when there. */
function fields(o: { [key: string]: WireValue }, keys: readonly string[]): string | null {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && !words(o[k]!, false).ok) return `${k} isn't plain text`;
  return null;
}

function menu(v: WireValue, depth = 0): Check {
  if (!Array.isArray(v)) return no("not a menu");
  if (depth > 4) return no("menus nest too deep");
  for (const e of v) {
    if (!isObj(e)) return no("a menu entry isn't an object");
    if (e.separator === true) continue;
    if (typeof e.label !== "string") return no("a menu entry has no label");
    const bad = fields(e, ["label"]);
    if (bad) return no(bad);
    if (e.run !== undefined && !isHandler(e.run)) return no("a menu entry's run isn't a handler");
    if (e.checked !== undefined && typeof e.checked !== "boolean") return no("checked isn't true or false");
    if (e.disabled !== undefined && typeof e.disabled !== "boolean") return no("disabled isn't true or false");
    if (e.submenu !== undefined) {
      const sub = menu(e.submenu, depth + 1);
      if (!sub.ok) return sub;
    }
  }
  return ok(v);
}

function action(v: WireValue): Check {
  if (!isObj(v) || typeof v.label !== "string" || !isHandler(v.run)) return no("not an action ({ label, run })");
  const bad = fields(v, ["label"]);
  return bad ? no(bad) : ok(v);
}

const STATE_KINDS = ["empty", "loading", "noResults", "error"];
function viewState(v: WireValue): Check {
  if (!isObj(v)) return no("not a view state");
  if (v.kind !== undefined && !STATE_KINDS.includes(v.kind as string)) return no(`kind ${JSON.stringify(v.kind)} isn't one of ${STATE_KINDS.join(", ")}`);
  const bad = fields(v, ["icon", "title", "text"]);
  if (bad) return no(bad);
  if (v.action !== undefined && v.action !== null) {
    const a = action(v.action);
    if (!a.ok) return a;
  }
  return ok(v);
}

function options(v: WireValue): Check {
  if (!Array.isArray(v)) return no("not a list of options");
  for (const o of v) {
    if (!isObj(o) || typeof o.value !== "string" || typeof o.label !== "string") return no("an option isn't { value, label }");
    const bad = fields(o, ["value", "label", "icon"]);
    if (bad) return no(bad);
  }
  return ok(v);
}

/** A prop's value against its ApiPropType. */
export function checkValue(type: ApiPropType, v: WireValue): Check {
  if (Array.isArray(type)) return (type as readonly (string | number)[]).includes(v as string | number) ? ok(v) : no(`${JSON.stringify(v)} isn't one of ${type.join(", ")}`);
  switch (type) {
    case "string":
      return words(v, false);
    case "text":
      return words(v, true);
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? ok(v) : no("not a number");
    case "boolean":
      return typeof v === "boolean" ? ok(v) : no("not true or false");
    case "numbers":
      return Array.isArray(v) && v.every((x) => x === null || (typeof x === "number" && Number.isFinite(x))) ? ok(v) : no("not a list of numbers");
    case "menu":
      return menu(v);
    case "action":
      return action(v);
    case "viewState":
      return viewState(v);
    case "options":
      return options(v);
    default:
      return no("an unknown type");
  }
}

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
    if (spec.events.includes(key)) return isHandler(v) ? v : this.drop(type, key, "not a handler");
    const t = spec.props[key];
    if (t === undefined) return this.drop(type, key, isHandler(v) ? "a handler on a prop that isn't one of its events" : "not a prop it takes in API 1");
    if (isHandler(v)) return this.drop(type, key, "a handler on a prop that isn't one of its events");
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

const isEl = (n: TreeNode | undefined): n is TreeElement => !!n && n.type !== "#text";

/** What stands in for a dropped node: nothing to draw, but it keeps its place. */
const placeholder = (id: number): TreeNode => ({ id, type: "#text", text: "" });
const isPlaceholder = (n: TreeNode) => n.type === "#text" && n.text === "";

/** Ops that can't apply: the tree here isn't the process's any more. */
class Lost extends Error {}

/** One window's tree. */
export class TreeStore {
  private snap: TreeSnapshot = { nodes: [], rev: 0, loaded: false, status: "starting", reason: undefined, detail: undefined };
  private byId = new Map<number, TreeNode>();
  private parentOf = new Map<number, number>();
  /** Ids dropped by the sanitiser (and their subtrees as sent): later ops on them are ignored, not a reason to resync. */
  private dropped = new Set<number>();
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
    return this.byId.get(id);
  }

  apply(m: TreeMessage): void {
    if (m.kind === "status") {
      this.set({ status: m.state, reason: m.reason, detail: m.detail });
    } else if (m.kind === "tree") {
      this.byId.clear();
      this.parentOf.clear();
      this.dropped.clear();
      this.resyncing = false;
      const nodes = this.adoptAll(m.nodes, TREE_ROOT);
      // The status stays as last told: a stopped process's last tree comes after its status on resync.
      this.set({ nodes, rev: m.rev, loaded: true });
    } else if (m.kind === "patch") {
      if (this.resyncing || m.rev <= this.snap.rev) return; // waiting for the tree, or old news
      if (!this.snap.loaded || m.rev !== this.snap.rev + 1) return this.lose();
      try {
        for (const op of m.ops) this.op(op);
      } catch (err) {
        if (err instanceof Lost) return this.lose();
        throw err;
      }
      this.set({ rev: m.rev });
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

  /** Sanitises nodes from the wire and indexes them under `parent`. */
  private adoptAll(nodes: readonly TreeNode[], parent: number): TreeNode[] {
    const parentType = parent === TREE_ROOT ? "root" : String(this.byId.get(parent)?.type);
    return nodes.map((n) => {
      const s = this.clean.node(n, parentType, (d) => this.forgetWire(d));
      this.index(s, parent);
      return s;
    });
  }

  /** Every id in a dropped subtree, as sent. */
  private forgetWire(n: TreeNode): void {
    this.dropped.add(n.id);
    if (n.type !== "#text") for (const c of n.children ?? []) this.forgetWire(c);
  }

  private index(n: TreeNode, parent: number): void {
    this.byId.set(n.id, n);
    this.parentOf.set(n.id, parent);
    if (isEl(n)) for (const c of n.children) this.index(c, n.id);
  }

  private unindex(n: TreeNode): void {
    this.byId.delete(n.id);
    this.parentOf.delete(n.id);
    if (isEl(n)) for (const c of n.children) this.unindex(c);
  }

  private children(parent: number): readonly TreeNode[] {
    if (parent === TREE_ROOT) return this.snap.nodes;
    const p = this.byId.get(parent);
    if (!isEl(p)) throw new Lost();
    return p.children;
  }

  /** Puts a new list of children on `parent`, copying it and its ancestors (immutable). */
  private setChildren(parent: number, list: TreeNode[]): void {
    if (parent === TREE_ROOT) {
      this.snap = { ...this.snap, nodes: list };
      return;
    }
    const p = this.byId.get(parent) as TreeElement;
    this.replace({ ...p, children: list });
  }

  /** Puts a changed copy of a node in place of the old one, up to the root. */
  private replace(n: TreeNode): void {
    const parent = this.parentOf.get(n.id)!;
    this.byId.set(n.id, n);
    this.setChildren(
      parent,
      this.children(parent).map((c) => (c.id === n.id ? n : c)),
    );
  }

  /** Whether an op names something the sanitiser dropped (then it is skipped). */
  private gone(id: number): boolean {
    return this.dropped.has(id);
  }

  private op(op: PatchOp): void {
    switch (op.op) {
      case "insert": {
        if (op.parent !== TREE_ROOT && this.gone(op.parent)) return this.forgetWire(op.node);
        const list = [...this.children(op.parent)];
        const parentType = op.parent === TREE_ROOT ? "root" : String(this.byId.get(op.parent)!.type);
        let node: TreeNode;
        if (this.clean.holds(parentType, op.node)) node = this.adoptAll([op.node], op.parent)[0]!;
        else {
          this.warn(`widget: <${parentType}> can't hold a ${op.node.type === "#text" ? "text" : `<${op.node.type}>`}: dropped`);
          this.forgetWire(op.node);
          node = placeholder(op.node.id);
          this.index(node, op.parent);
        }
        list.splice(Math.min(op.index, list.length), 0, node);
        this.setChildren(op.parent, list);
        return;
      }
      case "move": {
        if (this.gone(op.id)) return;
        const n = this.byId.get(op.id);
        if (!n) throw new Lost();
        if (op.parent !== TREE_ROOT && this.gone(op.parent)) {
          this.remove(n);
          this.unindex(n);
          return this.forgetWire(n);
        }
        this.remove(n);
        this.index(n, op.parent);
        const list = [...this.children(op.parent)];
        list.splice(Math.min(op.index, list.length), 0, n);
        this.setChildren(op.parent, list);
        return;
      }
      case "remove": {
        if (this.gone(op.id)) return;
        const n = this.byId.get(op.id);
        if (!n) throw new Lost();
        this.remove(n);
        this.unindex(n);
        return;
      }
      case "props": {
        if (this.gone(op.id)) return;
        const n = this.byId.get(op.id);
        if (!isEl(n)) throw new Lost();
        const props = { ...n.props, ...this.clean.props(n.type, op.set) };
        for (const k of op.unset) delete props[k];
        this.replace({ ...n, props });
        return;
      }
      case "text": {
        if (this.gone(op.id)) return;
        const n = this.byId.get(op.id);
        if (!n || n.type !== "#text") throw new Lost();
        const parent = this.parentOf.get(op.id)!;
        const type = parent === TREE_ROOT ? "root" : String(this.byId.get(parent)?.type);
        if (typeof op.text !== "string" || MARKUP.test(op.text)) {
          this.warn(`widget: a text in <${type}> dropped: markup in text`);
          return this.replace({ ...n, text: "" });
        }
        this.replace({ ...n, text: op.text });
        return;
      }
    }
  }

  /** Takes a node out of its parent's children (still indexed). */
  private remove(n: TreeNode): void {
    const parent = this.parentOf.get(n.id)!;
    const list = this.children(parent);
    if (!list.some((c) => c.id === n.id)) throw new Lost();
    this.setChildren(
      parent,
      list.filter((c) => c.id !== n.id),
    );
  }
}
