// Prop values against the element spec (widget-elements.ts): one check per prop type, the
// nested shapes (a menu, an action, a view state, options) each checked once, and the one
// test for a handler. The renderer's sanitiser (the trust boundary) runs these on every
// prop from the wire; the checks take the handler test as a parameter, so a function
// in the widget and a HandlerRef on the wire are judged the same way. And what a remote
// device gets of a tree: the same tree without handlers.

import { VALUE_MAX_BYTES, isShape, type ApiFieldSpec, type ApiPropType } from "./widget-spec.ts";
import type { HandlerRef, PatchOp, TreeNode, WidgetPatch, WidgetTree, WireValue } from "./widget-tree.ts";

/** What a View's state can be. */
export const VIEW_STATE_KINDS = ["empty", "loading", "noResults", "error"] as const;

const isObj = (v: unknown): v is { [key: string]: WireValue } => !!v && typeof v === "object" && !Array.isArray(v);

/** A handler on the wire: `{ $handler: <id> }` and nothing else. */
export const isHandler = (v: unknown): v is HandlerRef => !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { $handler?: unknown }).$handler === "number" && Object.keys(v).length === 1;

/** `<` before a letter or a slash: a tag, which no word in a widget needs. */
export const MARKUP = /<[a-zA-Z/!?]/;

export type ValueCheck = { ok: true; value: WireValue } | { ok: false; why: string };
const ok = (value: WireValue): ValueCheck => ({ ok: true, value });
const no = (why: string): ValueCheck => ({ ok: false, why });

/** Words: a string without markup (or a finite number, with `numbers`). */
function words(v: unknown, numbers: boolean): ValueCheck {
  if (typeof v === "number" && numbers) return Number.isFinite(v) ? ok(v) : no("not a finite number");
  if (typeof v !== "string") return no(numbers ? "not text" : "not a string");
  if (MARKUP.test(v)) return no("markup in text");
  return ok(v);
}

/** Optional string fields of an object: each a string without markup when there. */
function fields(o: { [key: string]: unknown }, keys: readonly string[]): string | null {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && !words(o[k], false).ok) return `${k} isn't plain text`;
  return null;
}

/** Whether `v` is a handler: a HandlerRef on the wire, a function in the widget. */
export type IsRun = (v: unknown) => boolean;

function menu(v: unknown, isRun: IsRun, depth = 0): ValueCheck {
  if (!Array.isArray(v)) return no("not a menu");
  if (depth > 4) return no("menus nest too deep");
  for (const e of v) {
    if (!isObj(e)) return no("a menu entry isn't an object");
    if (e.separator === true) continue;
    if (typeof e.label !== "string") return no("a menu entry has no label");
    const bad = fields(e, ["label"]);
    if (bad) return no(bad);
    if (e.run !== undefined && !isRun(e.run)) return no("a menu entry's run isn't a handler");
    if (e.checked !== undefined && typeof e.checked !== "boolean") return no("checked isn't true or false");
    if (e.disabled !== undefined && typeof e.disabled !== "boolean") return no("disabled isn't true or false");
    if (e.submenu !== undefined) {
      const sub = menu(e.submenu, isRun, depth + 1);
      if (!sub.ok) return sub;
    }
  }
  return ok(v as WireValue);
}

function action(v: unknown, isRun: IsRun): ValueCheck {
  if (!isObj(v) || typeof v.label !== "string" || !isRun(v.run)) return no("not an action ({ label, run })");
  const bad = fields(v, ["label"]);
  return bad ? no(bad) : ok(v);
}

function viewState(v: unknown, isRun: IsRun): ValueCheck {
  if (!isObj(v)) return no("not a view state");
  if (v.kind !== undefined && !(VIEW_STATE_KINDS as readonly unknown[]).includes(v.kind)) return no(`kind ${JSON.stringify(v.kind)} isn't one of ${VIEW_STATE_KINDS.join(", ")}`);
  const bad = fields(v, ["icon", "title", "text"]);
  if (bad) return no(bad);
  if (v.action !== undefined && v.action !== null) {
    const a = action(v.action, isRun);
    if (!a.ok) return a;
  }
  return ok(v);
}

function options(v: unknown): ValueCheck {
  if (!Array.isArray(v)) return no("not a list of options");
  for (const o of v) {
    if (!isObj(o) || typeof o.value !== "string" || typeof o.label !== "string") return no("an option isn't { value, label }");
    const bad = fields(o, ["value", "label", "icon"]);
    if (bad) return no(bad);
  }
  return ok(v as WireValue);
}

/** A Frame's `src`: an .html file of the package, by a relative path with no dot-file or `..` in it ("chart.html", "pages/meter.html"). */
export const isPackagePage = (s: unknown): s is string => typeof s === "string" && s.length <= 200 && /^[\w-][\w .-]*(\/[\w-][\w .-]*)*\.html$/i.test(s) && !s.split("/").some((seg) => seg.startsWith("."));

/** What a Frame says, in place and in its widget's log, when its page isn't there (a typo, a page not built yet). */
export const missingPage = (src: string): string => `${src} isn't in this package`;
/** The file a missingPage line names, or null when the line is about something else. */
export const missingPageOf = (message: string): string | null => /(\S+\.html) isn't in this package/.exec(message)?.[1] ?? null;

/** Plain data (a Frame's `data`, its page's message): no handler refs, no functions, not too deep, at most VALUE_MAX_BYTES. */
function plain(v: unknown): ValueCheck {
  const walk = (x: unknown, depth: number): string | null => {
    if (depth > 32) return "nested too deep";
    if (x === null || typeof x === "string" || typeof x === "boolean") return null;
    if (typeof x === "number") return Number.isFinite(x) ? null : "a number that isn't finite";
    if (Array.isArray(x)) {
      for (const y of x) {
        const bad = walk(y, depth + 1);
        if (bad) return bad;
      }
      return null;
    }
    if (isObj(x)) {
      if ("$handler" in x) return "a handler inside data";
      for (const y of Object.values(x)) {
        const bad = walk(y, depth + 1);
        if (bad) return bad;
      }
      return null;
    }
    return "not plain data";
  };
  const bad = walk(v, 0);
  if (bad) return no(bad);
  if (JSON.stringify(v).length > VALUE_MAX_BYTES) return no(`more than ${VALUE_MAX_BYTES / 1024} KB of data`);
  return ok(v as WireValue);
}

/** One record of named fields (1.2): each field present checked by its type, the required ones there; fields the spec doesn't name are left out. */
function record(v: unknown, fields: Readonly<Record<string, ApiFieldSpec>>, what: string): { ok: true; value: { [key: string]: WireValue } } | { ok: false; why: string } {
  if (!isObj(v)) return { ok: false, why: `${what} isn't an object` };
  const out: { [key: string]: WireValue } = {};
  for (const [k, f] of Object.entries(fields)) {
    const x = v[k];
    if (x === undefined || x === null) {
      if (f.required) return { ok: false, why: `${what} has no ${k}` };
      if (x === null && f.nullable) out[k] = null;
      continue;
    }
    const c = checkValue(f.type, x);
    if (!c.ok) return { ok: false, why: `${what}'s ${k}: ${c.why}` };
    out[k] = c.value;
  }
  return { ok: true, value: out };
}

function cells(v: unknown): ValueCheck {
  if (!Array.isArray(v)) return no("not a list of values");
  for (const x of v) {
    if (x === null) continue;
    const c = words(x, true);
    if (!c.ok) return c;
  }
  return ok(v as WireValue);
}

/** A prop's value against its ApiPropType (null aside: any prop may be null, which unsets it). */
export function checkValue(type: ApiPropType, v: unknown, isRun: IsRun = isHandler): ValueCheck {
  if (Array.isArray(type)) return (type as readonly unknown[]).includes(v) ? ok(v as WireValue) : no(`${JSON.stringify(v)} isn't one of ${type.join(", ")}`);
  if (isShape(type)) {
    if ("record" in type) return record(v, type.record, `a ${type.name}`);
    if (!Array.isArray(v)) return no(`not a list of ${type.name}`);
    const out: WireValue[] = [];
    for (const x of v) {
      const r = record(x, type.list, `a ${type.name}`);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return ok(out);
  }
  switch (type) {
    case "string":
    case "option":
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
      return menu(v, isRun);
    case "action":
      return action(v, isRun);
    case "viewState":
      return viewState(v, isRun);
    case "options":
      return options(v);
    case "strings":
      return Array.isArray(v) && v.every((x) => words(x, false).ok) ? ok(v as WireValue) : no("not a list of plain strings");
    case "matrix":
      return Array.isArray(v) && v.every((r) => Array.isArray(r) && r.every((x) => typeof x === "number" && Number.isFinite(x))) ? ok(v as WireValue) : no("not rows of numbers");
    case "cells":
      return cells(v);
    case "value":
      return plain(v);
    default:
      return no("an unknown type");
  }
}

// ── remote ──────────────────────────────────────────────

/** A prop value without handler refs: a ref goes (anything carrying a `$handler`), and so does a menu entry's or an action's `run` with it. */
function stripValue(v: WireValue): WireValue | undefined {
  if (isObj(v) && "$handler" in v) return undefined;
  if (Array.isArray(v)) return v.map(stripValue).filter((x): x is WireValue => x !== undefined);
  if (v && typeof v === "object") {
    const out: { [key: string]: WireValue } = {};
    for (const [k, x] of Object.entries(v)) {
      const s = stripValue(x);
      if (s !== undefined) out[k] = s;
    }
    return out;
  }
  return v;
}

function stripProps(props: Record<string, WireValue>): Record<string, WireValue> {
  const out: Record<string, WireValue> = {};
  for (const [k, v] of Object.entries(props)) {
    const s = stripValue(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

function stripNode(n: TreeNode): TreeNode {
  return n.type === "#text" ? n : { ...n, props: stripProps(n.props), children: n.children.map(stripNode) };
}

/**
 * A widget's tree or patch as a view-scope device gets it (docs/56, "Remote"): no handler
 * refs anywhere, so nothing on it can be pressed. A props op's set loses its handlers and
 * unsets those props instead, so a handler sent before can't linger. Anything else passes.
 */
export function withoutHandlers<M extends WidgetTree | WidgetPatch | { kind: string }>(m: M): M {
  if (m.kind === "tree") {
    const t = m as unknown as WidgetTree;
    return { ...t, nodes: t.nodes.map(stripNode) } as unknown as M;
  }
  if (m.kind === "patch") {
    const p = m as unknown as WidgetPatch;
    const ops = p.ops.map((op): PatchOp => {
      if (op.op === "insert") return { ...op, node: stripNode(op.node) };
      if (op.op !== "props") return op;
      const set = stripProps(op.set);
      const gone = Object.keys(op.set).filter((k) => !(k in set));
      return { ...op, set, unset: [...op.unset, ...gone] };
    });
    return { ...p, ops } as unknown as M;
  }
  return m;
}
