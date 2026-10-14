// The reconciler (docs/56, "The view"): React in the widget process renders into a tree
// of API elements kept here, and every commit goes out as one message: the whole tree the
// first time (and on `resync`), a patch of ops by node id after. Function props become
// handler ids that stay the same while the prop keeps its place, so a fresh arrow
// function each render changes nothing on the wire. A render error is caught by a
// boundary that sends `error` and draws a Callout with the stack; the process lives on.

import { Component, createContext, createElement, type ReactNode } from "react";
import createReconciler from "react-reconciler";
import type { PatchOp, TreeNode, WireValue } from "@cmd/protocol/widget-tree";
import type { Connection } from "./connection.ts";

// react-reconciler/constants (inlined: the module is CommonJS behind a condition).
const ConcurrentRoot = 1;
const NoEventPriority = 0;
const DiscreteEventPriority = 2;
const DefaultEventPriority = 32;

interface Instance {
  id: number;
  type: string;
  props: Record<string, WireValue>;
  children: Child[];
  parent: Parent | null;
  /** Handler ids by the prop path they sit at ("onClick", "menu.0.run"). */
  handlers: Map<string, number>;
  hidden: boolean;
}
interface TextInstance {
  id: number;
  type: "#text";
  text: string;
  parent: Parent | null;
  hidden: boolean;
}
type Child = Instance | TextInstance;
interface Container {
  root: TreeRoot;
  children: Child[];
}
type Parent = Instance | Container;

const isContainer = (p: Parent): p is Container => "root" in p;

let currentPriority = NoEventPriority;

/** The tree of one widget and its link to the connection. */
export class TreeRoot {
  readonly conn: Connection;
  readonly container: Container;
  private ops: PatchOp[] = [];
  private sent = false;
  private rev = 0;
  private nextId = 1;
  private nextHandler = 1;
  private fiberRoot: unknown = null;

  constructor(conn: Connection) {
    this.conn = conn;
    this.container = { root: this, children: [] };
    conn.onResync = () => this.sendTree();
    conn.runHandler = (fn, value) => {
      const prev = currentPriority;
      currentPriority = DiscreteEventPriority;
      try {
        const r = fn(value);
        if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).catch((e: unknown) => this.report(e, null));
      } catch (e) {
        this.report(e, null);
      } finally {
        currentPriority = prev;
      }
    };
  }

  id(): number {
    return this.nextId++;
  }

  /** Renders `element` (inside the error boundary); the first commit sends the tree. */
  render(element: ReactNode): void {
    if (!this.fiberRoot) {
      this.fiberRoot = reconciler.createContainer(
        this.container,
        ConcurrentRoot,
        null,
        false,
        null,
        "",
        (e) => this.report(e, null),
        () => {}, // caught: the boundary reports it with its component stack
        () => {},
        () => {},
        null,
      );
    }
    reconciler.updateContainerSync(createElement(Boundary, { root: this }, element), this.fiberRoot as never, null, null);
    reconciler.flushSyncWork();
  }

  unmount(): void {
    if (!this.fiberRoot) return;
    reconciler.updateContainerSync(null, this.fiberRoot as never, null, null);
    reconciler.flushSyncWork();
    this.fiberRoot = null;
  }

  /** An error outside rendering (a handler, a rejected promise) or one no boundary caught. */
  report(e: unknown, componentStack: string | null): void {
    const err = e instanceof Error ? e : new Error(String(e));
    this.conn.send({ kind: "error", message: err.message, stack: err.stack ?? null, componentStack });
  }

  sendTree(): void {
    this.ops = [];
    this.sent = true;
    this.conn.send({ kind: "tree", rev: ++this.rev, nodes: this.container.children.map((c) => this.node(c)) });
  }

  /** After each commit: the first tree, else the ops of the commit as one patch. */
  flush(): void {
    if (!this.sent) return this.sendTree();
    if (!this.ops.length) return;
    const ops = this.ops;
    this.ops = [];
    this.conn.send({ kind: "patch", rev: ++this.rev, ops });
  }

  op(parent: Parent | null, op: PatchOp): void {
    if (this.sent && parent && attached(parent)) this.ops.push(op);
  }

  node(c: Child): TreeNode {
    if (c.type === "#text") return { id: c.id, type: "#text", text: c.hidden ? "" : this.mask((c as TextInstance).text) };
    const i = c as Instance;
    const props = i.hidden ? { ...i.props, $hidden: true } : { ...i.props };
    return { id: i.id, type: i.type as never, props, children: i.children.map((ch) => this.node(ch)) };
  }

  /** Props as JSON; functions become handler ids kept by path. */
  wire(inst: Instance, props: Record<string, unknown>): Record<string, WireValue> {
    const seen = new Set<string>();
    const out: Record<string, WireValue> = {};
    for (const [k, v] of Object.entries(props)) {
      if (k === "children" || v === undefined) continue;
      out[k] = this.value(inst, v, k, seen);
    }
    for (const [path, id] of inst.handlers) {
      if (seen.has(path)) continue;
      inst.handlers.delete(path);
      this.conn.handlers.delete(id);
    }
    return out;
  }

  private value(inst: Instance, v: unknown, path: string, seen: Set<string>): WireValue {
    if (typeof v === "function") {
      seen.add(path);
      let id = inst.handlers.get(path);
      if (id === undefined) inst.handlers.set(path, (id = this.nextHandler++));
      this.conn.handlers.set(id, v as (value?: unknown) => unknown);
      return { $handler: id };
    }
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") return this.mask(v);
    if (typeof v === "bigint") return Number(v);
    if (Array.isArray(v)) return v.map((x, n) => (x === undefined ? null : this.value(inst, x, `${path}.${n}`, seen)));
    if (typeof v === "object") {
      const j = (v as { toJSON?: () => unknown }).toJSON;
      if (typeof j === "function") return this.value(inst, j.call(v), path, seen);
      const o: Record<string, WireValue> = {};
      for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = this.value(inst, x, `${path}.${k}`, seen);
      return o;
    }
    return null; // symbols, undefined
  }

  /** A secret read with cmd.secrets never reaches a tree. */
  mask(s: string): string {
    for (const secret of this.conn.secrets) if (secret.length >= 4 && s.includes(secret)) s = s.split(secret).join("••••");
    return s;
  }

  free(c: Child): void {
    if (c.type === "#text") return;
    const i = c as Instance;
    for (const id of i.handlers.values()) this.conn.handlers.delete(id);
    i.handlers.clear();
    for (const ch of i.children) this.free(ch);
  }
}

function attached(p: Parent): boolean {
  let at: Parent | null = p;
  while (at && !isContainer(at)) at = at.parent;
  return !!at;
}

const rootOf = (p: Parent): TreeRoot => {
  let at: Parent | null = p;
  while (at && !isContainer(at)) at = at.parent;
  if (!at) throw new Error("widget-api: a node outside any tree");
  return at.root;
};
const pid = (p: Parent) => (isContainer(p) ? 0 : p.id);

function place(parent: Parent, child: Child, before: Child | null): void {
  const list = parent.children;
  const was = list.indexOf(child);
  if (was >= 0) list.splice(was, 1);
  const index = before ? list.indexOf(before) : list.length;
  list.splice(index < 0 ? list.length : index, 0, child);
  child.parent = parent;
  const root = rootOf(parent);
  root.op(parent, was >= 0 ? { op: "move", id: child.id, parent: pid(parent), index } : { op: "insert", parent: pid(parent), index, node: root.node(child) });
}

function remove(parent: Parent, child: Child): void {
  const list = parent.children;
  const at = list.indexOf(child);
  if (at < 0) return;
  const root = rootOf(parent);
  list.splice(at, 1);
  root.op(parent, { op: "remove", id: child.id });
  child.parent = null;
  root.free(child);
}

function setHidden(c: Child, hidden: boolean): void {
  c.hidden = hidden;
  if (!c.parent) return;
  const root = rootOf(c.parent);
  if (c.type === "#text") root.op(c.parent, { op: "text", id: c.id, text: hidden ? "" : root.mask((c as TextInstance).text) });
  else root.op(c.parent, hidden ? { op: "props", id: c.id, set: { $hidden: true }, unset: [] } : { op: "props", id: c.id, set: {}, unset: ["$hidden"] });
}

const same = (a: WireValue | undefined, b: WireValue | undefined) => a === b || JSON.stringify(a) === JSON.stringify(b);

type Props = Record<string, unknown>;
interface HostContext {
  root: TreeRoot;
}

const reconciler = createReconciler<string, Props, Container, Instance, TextInstance, never, never, never, never, Instance, HostContext, never, number, number, null, null, null, never, never, never>({
  rendererVersion: "1.0.0",
  rendererPackageName: "@cmd/widget-api",
  extraDevToolsConfig: null,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  warnsIfNotActing: false,
  supportsMicrotasks: true,
  scheduleMicrotask: (fn) => queueMicrotask(fn),
  scheduleTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  cancelTimeout: (id) => clearTimeout(id),
  noTimeout: -1,

  createInstance(type, props, container) {
    const root = container.root;
    const inst: Instance = { id: root.id(), type, props: {}, children: [], parent: null, handlers: new Map(), hidden: false };
    inst.props = root.wire(inst, props);
    return inst;
  },
  createTextInstance: (text, container) => ({ id: container.root.id(), type: "#text", text, parent: null, hidden: false }),
  appendInitialChild(parent, child) {
    parent.children.push(child);
    child.parent = parent;
  },
  finalizeInitialChildren: () => false,
  shouldSetTextContent: () => false,
  getRootHostContext: (container) => ({ root: container.root }),
  getChildHostContext: (parent) => parent,
  getPublicInstance: (i) => i as Instance,
  prepareForCommit: () => null,
  resetAfterCommit: (container) => container.root.flush(),
  preparePortalMount: () => {},

  appendChild: (parent, child) => place(parent, child, null),
  appendChildToContainer: (container, child) => place(container, child, null),
  insertBefore: (parent, child, before) => place(parent, child, before as Child),
  insertInContainerBefore: (container, child, before) => place(container, child, before as Child),
  removeChild: (parent, child) => remove(parent, child as Child),
  removeChildFromContainer: (container, child) => remove(container, child as Child),
  clearContainer(container) {
    for (const c of [...container.children]) remove(container, c);
  },
  commitUpdate(inst, _type, _prev, next) {
    if (!inst.parent) return;
    const root = rootOf(inst.parent);
    const before = inst.props;
    const after = root.wire(inst, next);
    inst.props = after;
    const set: Record<string, WireValue> = {};
    const unset: string[] = [];
    for (const [k, v] of Object.entries(after)) if (!same(before[k], v)) set[k] = v;
    for (const k of Object.keys(before)) if (!(k in after)) unset.push(k);
    if (Object.keys(set).length || unset.length) root.op(inst.parent, { op: "props", id: inst.id, set, unset });
  },
  commitTextUpdate(t, _old, text) {
    t.text = text;
    if (t.parent) {
      const root = rootOf(t.parent);
      root.op(t.parent, { op: "text", id: t.id, text: root.mask(text) });
    }
  },
  resetTextContent: () => {},
  hideInstance: (i) => setHidden(i, true),
  unhideInstance: (i) => setHidden(i, false),
  hideTextInstance: (t) => setHidden(t, true),
  unhideTextInstance: (t) => setHidden(t, false),
  detachDeletedInstance: () => {},

  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  prepareScopeUpdate: () => {},
  getInstanceFromScope: () => null,

  NotPendingTransition: null,
  HostTransitionContext: createContext(null) as never,
  setCurrentUpdatePriority: (p) => void (currentPriority = p),
  getCurrentUpdatePriority: () => currentPriority,
  resolveUpdatePriority: () => (currentPriority !== NoEventPriority ? currentPriority : DefaultEventPriority),
  resetFormInstance: () => {},
  requestPostPaintCallback: () => {},
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: () => {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => Date.now(),
  maySuspendCommit: () => false,
  maySuspendCommitOnUpdate: () => false,
  maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => null,
  suspendInstance: () => {},
  suspendOnActiveViewTransition: () => {},
  waitForCommitToBeReady: () => null,
  getSuspendedCommitReason: () => null,
  bindToConsole: (method, args) => (console as unknown as Record<string, (...a: unknown[]) => void>)[method]!.bind(console, ...args),
});

interface BoundaryState {
  error: Error | null;
}

/** Catches a render error: reports it once with its stack and draws it as a Callout in the window. */
class Boundary extends Component<{ root: TreeRoot; children?: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(e: unknown): BoundaryState {
    return { error: e instanceof Error ? e : new Error(String(e)) };
  }

  override componentDidCatch(e: unknown, info: { componentStack?: string | null }): void {
    this.props.root.report(e, info.componentStack ?? null);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return createElement(
      "Callout",
      { tone: "danger", title: "This widget hit an error" },
      createElement("Text", { mono: true, select: true, size: "sm" }, error.stack ?? error.message),
      createElement("Button", { onClick: () => this.setState({ error: null }) }, "Try Again"),
    );
  }
}
