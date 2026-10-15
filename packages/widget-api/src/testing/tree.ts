// The tree a test sees: built from the process's own `tree` and `patch` messages the way
// the app's renderer builds it (the protocol's WireTree: a patch the app would refuse fails
// the test), with finders, the interactions a person would make (press, change, a menu
// entry) and the matchers. Which
// events a gesture fires and which props are an element's title and words is the
// protocol's element spec (API_ELEMENTS).

import { API_ELEMENTS, isHandler, type ApiElementSpec, type ApiGesture, type HandlerRef, type TreeElement, type TreeNode, type WidgetOut, type WireValue } from "@cmd/protocol/widget-tree";
import { PatchError, WireTree } from "@cmd/protocol/widget-patch";
import type { FakeHost } from "./host.ts";

/** A node of the rendered tree. @since 1.0 */
export type Node = TreeNode;
/** An element of the rendered tree. @since 1.0 */
export type Element = TreeElement;

const isEl = (n: TreeNode | undefined): n is TreeElement => !!n && n.type !== "#text";
const specOf = (type: string): ApiElementSpec | undefined => (Object.hasOwn(API_ELEMENTS, type) ? (API_ELEMENTS as Record<string, ApiElementSpec>)[type] : undefined);
/** The prop that is an element's title (`find(type, title)`). */
const titleProp = (type: string): string | undefined => Object.entries(specOf(type)?.props ?? {}).find(([, p]) => p.shows === "title")?.[0];
/** The props that are an element's words (`text()`), its title first. */
const wordProps = (type: string): string[] => {
  const props = Object.entries(specOf(type)?.props ?? {});
  return [...props.filter(([, p]) => p.shows === "title"), ...props.filter(([, p]) => p.shows === "words")].map(([k]) => k);
};

/** Keeps a copy of the widget's tree from its messages, applied as the core and the app apply them (protocol widget-patch.ts). */
export class Mirror {
  rev = 0;
  trees = 0;
  patches = 0;
  private readonly tree = new WireTree({ adopt: (n) => structuredClone(n), props: (_, set) => structuredClone(set) });

  get nodes(): TreeNode[] {
    return this.tree.roots as TreeNode[];
  }

  apply(m: WidgetOut): void {
    if (m.kind === "tree") {
      this.tree.load(m);
      this.rev = m.rev;
      this.trees++;
    } else if (m.kind === "patch") {
      try {
        this.tree.apply(m);
      } catch (e) {
        if (e instanceof PatchError) throw new Error(`${e.message}: the renderer would resync`);
        throw e;
      }
      this.rev = m.rev;
      this.patches++;
    }
  }
}

function walk(nodes: TreeNode[], fn: (n: TreeElement) => void): void {
  for (const n of nodes) {
    if (!isEl(n) || n.props.$hidden) continue;
    fn(n);
    walk(n.children, fn);
  }
}

/** The words of a node: its texts and its text props, in order. @since 1.0 */
export function textOf(n: TreeNode | TreeNode[]): string {
  const out: string[] = [];
  const go = (x: TreeNode) => {
    if (x.type === "#text") return void (x.text && out.push(x.text));
    if (x.props.$hidden) return;
    for (const k of wordProps(x.type)) {
      const v = x.props[k];
      if (typeof v === "string" || typeof v === "number") out.push(String(v));
    }
    x.children.forEach(go);
  };
  (Array.isArray(n) ? n : [n]).forEach(go);
  return out.join(" ");
}

/** A row's title (its ListRowContent's), a section's or a stat's label; else its words. @since 1.0 */
export function titleOf(n: TreeNode): string {
  if (!isEl(n)) return n.text;
  if (n.type === "ListRow") {
    const c = n.children.find((c) => isEl(c) && c.type === "ListRowContent") as TreeElement | undefined;
    if (c) return String(c.props.title ?? "");
  }
  const k = titleProp(n.type);
  if (k && (typeof n.props[k] === "string" || typeof n.props[k] === "number")) return String(n.props[k]);
  return textOf(n);
}

/** What `render` returns: the tree as the app would draw it, and a person's hands. @since 1.0 */
export class RenderedTree {
  readonly host: FakeHost;
  readonly mirror: Mirror;
  private readonly settle: () => Promise<void>;
  private readonly stopFn: () => void;

  constructor(host: FakeHost, mirror: Mirror, settle: () => Promise<void>, stop: () => void) {
    this.host = host;
    this.mirror = mirror;
    this.settle = settle;
    this.stopFn = stop;
  }

  /** The top-level nodes. */
  get nodes(): TreeNode[] {
    return this.mirror.nodes;
  }

  /** Every element of `type` (and matching `where`), in order. */
  findAll(type: string, where?: (n: TreeElement) => boolean): TreeElement[] {
    const out: TreeElement[] = [];
    walk(this.nodes, (n) => n.type === type && (!where || where(n)) && out.push(n));
    return out;
  }

  /** The first element of `type` (matching `where`, or with that title); throws when there is none. */
  find(type: string, where?: string | ((n: TreeElement) => boolean)): TreeElement {
    const pred = typeof where === "string" ? (n: TreeElement) => titleOf(n) === where : where;
    const n = this.findAll(type, pred)[0];
    if (!n) throw new Error(`no ${type}${typeof where === "string" ? ` "${where}"` : ""} in the tree:\n${this.toString()}`);
    return n;
  }

  /** The ListRows, in order. */
  rows(): TreeElement[] {
    return this.findAll("ListRow");
  }

  /** The ListSections, in order. */
  sections(): TreeElement[] {
    return this.findAll("ListSection");
  }

  /** The tree's words. */
  text(): string {
    return textOf(this.nodes);
  }

  /** Waits until the widget has nothing left to do (calls answered, renders committed). */
  async idle(): Promise<void> {
    await this.settle();
  }

  /** Fires the first of the element's events for `gesture` that it has a handler on. */
  private async fire(n: TreeElement, gesture: ApiGesture, value?: WireValue): Promise<void> {
    const names = Object.entries(specOf(n.type)?.events ?? {})
      .filter(([, e]) => e.gesture === gesture)
      .map(([k]) => k);
    const name = names.find((k) => isHandler(n.props[k]));
    if (!name) throw new Error(`${n.type} "${titleOf(n)}" has ${names.length ? `no ${names.join(" or ")}` : `nothing to ${gesture}`}`);
    this.host.deliver({ kind: "interaction", handler: (n.props[name] as HandlerRef).$handler, event: name, ...(value === undefined ? {} : { value }) });
    await this.settle();
  }

  /** Presses a row, a button, a section's heading or a stat (its onClick, onToggle or onSelect). */
  press(n: TreeElement): Promise<void> {
    return this.fire(n, "press");
  }

  /** Double-clicks a row. */
  doubleClick(n: TreeElement): Promise<void> {
    return this.fire(n, "doubleClick");
  }

  /** Types into a field or picks a segment: its onChange with `value`. */
  change(n: TreeElement, value: WireValue): Promise<void> {
    return this.fire(n, "change", value);
  }

  /**
   * Picks one of an element's things by the value its event carries: a DataGrid's row by key
   * (`onRowClick`, or `event` to name another: "onRowDoubleClick", "onToggle", "onSort"), a
   * chart's bucket by index, a Ribbon's bar by id, a TimeBar's time. @since 1.2
   */
  async pick(n: TreeElement, value: WireValue, event?: string): Promise<void> {
    if (!event) return this.fire(n, "pick", value);
    const ref = n.props[event];
    if (specOf(n.type)?.events[event]?.gesture !== "pick" || !isHandler(ref)) throw new Error(`${n.type} "${titleOf(n)}" has no ${event}`);
    this.host.deliver({ kind: "interaction", handler: ref.$handler, event, value });
    await this.settle();
  }

  /** A Frame's page sends `value` (`cmd.post` there): the Frame's onMessage. @since 1.2 */
  message(n: TreeElement, value: WireValue): Promise<void> {
    return this.fire(n, "message", value);
  }

  /** Submits a field. */
  submit(n: TreeElement, value: WireValue): Promise<void> {
    return this.fire(n, "submit", value);
  }

  /** Chooses an entry of a node's `menu` (a row's context menu, the Window's title menu), or the action of an EmptyState or a View's state. */
  async choose(n: TreeElement, label: string, prop = "menu"): Promise<void> {
    const find = (entries: WireValue | undefined): HandlerRef | undefined => {
      if (!Array.isArray(entries)) return undefined;
      for (const e of entries as { label?: string; run?: HandlerRef; submenu?: WireValue }[]) {
        if (e.label === label && isHandler(e.run)) return e.run;
        const inner = find(e.submenu);
        if (inner) return inner;
      }
      return undefined;
    };
    // An EmptyState's action, or a View's state's.
    const action = (n.props.action ?? (n.props.state as { action?: unknown } | null | undefined)?.action) as { label?: string; run?: HandlerRef } | undefined;
    const run = find(n.props[prop]) ?? (action?.label === label && isHandler(action.run) ? action.run : undefined);
    if (!run) throw new Error(`${n.type} "${titleOf(n)}" has no menu entry "${label}"`);
    this.host.deliver({ kind: "interaction", handler: run.$handler, event: "run" });
    await this.settle();
  }

  /** Unmounts the widget (its subscriptions end) and stops its runtime. */
  unmount(): void {
    this.stopFn();
  }

  /** The tree as nested data without ids or handler numbers, for snapshots. */
  toJSON(): unknown {
    const strip = (v: WireValue): unknown => (isHandler(v) ? "ƒ" : Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, strip(x)])) : v);
    const go = (n: TreeNode): unknown => (n.type === "#text" ? n.text : { type: n.type, props: strip(n.props), children: n.children.map(go) });
    return this.nodes.map(go);
  }

  toString(): string {
    const line = (n: TreeNode, depth: number): string[] => {
      const pad = "  ".repeat(depth);
      if (n.type === "#text") return [`${pad}"${n.text}"`];
      const props = Object.entries(n.props)
        .map(([k, v]) => `${k}=${isHandler(v) ? "ƒ" : JSON.stringify(v)}`)
        .join(" ");
      return [`${pad}<${n.type}${props ? " " + props : ""}>`, ...n.children.flatMap((c) => line(c, depth + 1))];
    };
    return this.nodes.flatMap((n) => line(n, 0)).join("\n");
  }
}

type Result = { pass: boolean; message: () => string };
const asTree = (r: unknown): RenderedTree => {
  if (r instanceof RenderedTree) return r;
  throw new Error("expected the tree that render() returns");
};

/** The matchers (`expect.extend(matchers)`; testing installs them in vitest by itself). @since 1.0 */
export const matchers = {
  /** A ListSection with this title; with `count`, its count prop (else its number of rows) is that. */
  toHaveSection(received: unknown, title: string, opts: { count?: number } = {}): Result {
    const t = asTree(received);
    const s = t.sections().find((n) => n.props.title === title);
    const count = s ? (typeof s.props.count === "number" ? s.props.count : s.children.filter((c) => isEl(c) && c.type === "ListRow").length) : null;
    const pass = !!s && (opts.count === undefined || count === opts.count);
    const have = t.sections().map((n) => `"${String(n.props.title)}" (${String(n.props.count ?? "–")})`).join(", ") || "none";
    return { pass, message: () => `expected ${pass ? "no " : ""}section "${title}"${opts.count === undefined ? "" : ` with count ${opts.count}`}; sections: ${have}` };
  },
  /** A ListRow with this title (a RegExp matches its words). */
  toHaveRow(received: unknown, title: string | RegExp): Result {
    const rows = asTree(received).rows();
    const pass = rows.some((r) => (typeof title === "string" ? titleOf(r) === title : title.test(textOf(r))));
    return { pass, message: () => `expected ${pass ? "no " : ""}row ${String(title)}; rows: ${rows.map((r) => `"${titleOf(r)}"`).join(", ") || "none"}` };
  },
  /** A node (a row, a section, a stat) with this title. */
  toHaveTitle(received: unknown, title: string): Result {
    const n = received as TreeNode;
    const got = n && typeof n === "object" && "type" in n ? titleOf(n) : String(received);
    return { pass: got === title, message: () => `expected title "${title}", got "${got}"` };
  },
  /** A Stat with this label, and this value when given. */
  toHaveStat(received: unknown, label: string, value?: string | number): Result {
    const stats = asTree(received).findAll("Stat");
    const s = stats.find((n) => n.props.label === label);
    const pass = !!s && (value === undefined || String(s.props.value) === String(value));
    return { pass, message: () => `expected stat "${label}"${value === undefined ? "" : ` = ${value}`}; stats: ${stats.map((n) => `${String(n.props.label)} = ${String(n.props.value)}`).join(", ") || "none"}` };
  },
  /**
   * A state shown: a View's `state` of this kind ("empty" by default), an EmptyState
   * (kind "empty"), or the error Callout (kind "error"); with `title`, that title too.
   */
  toShowState(received: unknown, kind: "empty" | "loading" | "noResults" | "error" = "empty", title?: string): Result {
    const t = asTree(received);
    const shown: { kind: string; title: string }[] = [];
    for (const v of t.findAll("View")) {
      const s = v.props.state as { kind?: string; title?: string } | null | undefined;
      if (s && typeof s === "object") shown.push({ kind: s.kind ?? "empty", title: s.title ?? "" });
    }
    for (const e of t.findAll("EmptyState")) shown.push({ kind: "empty", title: String(e.props.title ?? "") });
    for (const c of t.findAll("Callout", (n) => n.props.tone === "danger")) shown.push({ kind: "error", title: String(c.props.title ?? "") });
    const pass = shown.some((s) => s.kind === kind && (title === undefined || s.title === title));
    return { pass, message: () => `expected ${pass ? "no " : ""}${kind} state${title ? ` "${title}"` : ""}; shown: ${shown.map((s) => `${s.kind} "${s.title}"`).join(", ") || "none"}` };
  },
};

/** The matchers' types, for `expect(tree)`. @since 1.0 */
export interface WidgetMatchers<R = unknown> {
  toHaveSection(title: string, opts?: { count?: number }): R;
  toHaveRow(title: string | RegExp): R;
  toHaveTitle(title: string): R;
  toHaveStat(label: string, value?: string | number): R;
  toShowState(kind?: "empty" | "loading" | "noResults" | "error", title?: string): R;
}
