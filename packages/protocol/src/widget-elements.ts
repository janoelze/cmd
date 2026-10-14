// The elements of the widget API (docs/56, "The view") and what a remote device gets of a tree:
// split from widget-tree.ts, which re-exports all of it, so `@cmd/protocol/widget-tree` is still
// the whole wire contract. API_ELEMENTS is the allow-list the renderer enforces.

import type { HandlerRef, PatchOp, TreeNode, WidgetPatch, WidgetTree, WireValue } from "./widget-tree.ts";

// ── the elements ────────────────────────────────────────

/**
 * A prop's type on the wire. A string array is an enum. "text" is a string or a
 * number; "numbers" a number[]; "menu" a MenuEntry[] whose `run`s are handlers;
 * "action" `{ label, run }`; "viewState" View's state; "options" a Segmented's.
 */
export type ApiPropType = "string" | "text" | "number" | "boolean" | "numbers" | "menu" | "action" | "viewState" | "options" | readonly (string | number)[];

export interface ApiElementSpec {
  props: Record<string, ApiPropType>;
  /** The handler props it takes ("onClick"); a handler anywhere else is dropped. */
  events: readonly string[];
  /** What it holds: nothing, strings only, elements only, or both. */
  children: "none" | "text" | "elements" | "any";
}

const SPACE = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12] as const;
const TONES = ["neutral", "accent", "success", "warning", "danger"] as const;
const LIGHTS = ["needs", "unseen", "working", "done", "idle", "off", ...TONES] as const;
const TEXT_SIZES = ["2xs", "xs", "sm", "md", "base", "lg", "xl", "display"] as const;
const ALIGN = ["start", "center", "end", "stretch", "baseline"] as const;
const BAR_TONES = ["accent", "danger", "needs"] as const;
const BREAKS = ["narrow", "regular"] as const;
const none = { props: {}, events: [], children: "none" } as const;
/** What every toolbar item takes: its place in the ⋯ menu when room runs out, faded until hovered. */
const ITEM = { priority: "number", secondary: "boolean" } as const;

/** API 1's elements, with each one's props and events: the allow-list the renderer enforces. */
export const API_ELEMENTS = {
  Window: { props: { status: "string", menu: "menu", actions: "menu" }, events: [], children: "elements" },
  View: { props: { inset: "boolean", scroll: "boolean", state: "viewState" }, events: [], children: "elements" },
  WindowToolbar: { props: { label: "string", bottom: "boolean" }, events: [], children: "elements" },
  ToolbarButton: { props: { label: "string", icon: "string", showLabel: "boolean", pressed: "boolean", disabled: "boolean", tone: BAR_TONES, badge: "text", tip: "string", ...ITEM }, events: ["onClick"], children: "none" },
  ToolbarField: { props: { value: "string", placeholder: "string", icon: "string", ...ITEM }, events: ["onChange", "onSubmit"], children: "none" },
  ToolbarSearchField: { props: { value: "string", placeholder: "string", count: "text", ...ITEM }, events: ["onChange"], children: "none" },
  ToolbarSegmented: { props: { value: "string", options: "options", label: "string", ...ITEM }, events: ["onChange"], children: "none" },
  ToolbarMenu: { props: { label: "string", icon: "string", menu: "menu", disabled: "boolean", ...ITEM }, events: [], children: "none" },
  ToolbarText: { props: { ...ITEM }, events: [], children: "text" },
  ToolbarSpacer: none,
  Stack: { props: { gap: SPACE, pad: [...SPACE, "inset"], padY: SPACE, align: ALIGN, grow: "boolean" }, events: [], children: "elements" },
  Inline: { props: { gap: SPACE, align: ALIGN, justify: ["start", "between", "end"], wrap: "boolean", grow: "boolean" }, events: [], children: "elements" },
  Tiles: { props: { min: [96, 120, 160, 200, 240, 320], gap: SPACE }, events: [], children: "elements" },
  Hide: { props: { below: BREAKS, above: BREAKS }, events: [], children: "elements" },
  List: { props: {}, events: [], children: "elements" },
  ListSection: { props: { title: "string", count: "number", open: "boolean", tone: ["needs", "danger"] }, events: ["onToggle"], children: "elements" },
  ListRow: { props: { selected: "boolean", dim: "boolean", depth: "number", tip: "string", menu: "menu" }, events: ["onClick", "onDoubleClick"], children: "elements" },
  ListRowIcon: { props: { icon: "string", light: LIGHTS, tone: [...LIGHTS, "dim"] }, events: [], children: "none" },
  ListRowContent: { props: { title: "text", place: "text", detail: "text", tone: ["needs", "danger"], mono: "boolean" }, events: [], children: "none" },
  ListRowEnd: { props: {}, events: [], children: "any" },
  Chip: { props: { hue: "number", tip: "string" }, events: [], children: "text" },
  Stat: { props: { label: "string", value: "text", unit: "string", delta: "text", deltaTone: TONES }, events: ["onSelect"], children: "none" },
  Sparkline: { props: { values: "numbers", height: "number", area: "boolean", color: ["current", "neutral"] }, events: [], children: "none" },
  Text: { props: { tone: ["dim", ...TONES], size: TEXT_SIZES, mono: "boolean", strong: "boolean", truncate: "boolean", select: "boolean", balance: "boolean" }, events: [], children: "text" },
  Badge: { props: { tone: TONES, size: ["sm", "md"], solid: "boolean", tip: "string" }, events: [], children: "text" },
  StatusDot: { props: { state: LIGHTS, size: ["sm", "md"], label: "string" }, events: [], children: "none" },
  Button: { props: { variant: ["default", "primary", "danger", "ghost"], size: ["sm", "md", "lg"], icon: "string", pressed: "boolean", busy: "boolean", disabled: "boolean" }, events: ["onClick"], children: "text" },
  EmptyState: { props: { icon: "string", title: "string", text: "string", action: "action", compact: "boolean" }, events: [], children: "none" },
  Callout: { props: { tone: TONES, title: "string", icon: "string", compact: "boolean", banner: "boolean" }, events: ["onDismiss"], children: "any" },
  Progress: { props: { value: "number", tone: TONES, label: "string" }, events: [], children: "none" },
} as const satisfies Record<string, ApiElementSpec>;

export type ApiElement = keyof typeof API_ELEMENTS;
export const API_ELEMENT_NAMES = Object.keys(API_ELEMENTS) as ApiElement[];

/** A menu entry in a prop (`Window menu`, `ListRow menu`): data, with `run` as a handler. */
export type WireMenuEntry = { label: string; run?: HandlerRef; checked?: boolean; disabled?: boolean; submenu?: WireMenuEntry[] } | { separator: true };

// ── remote ──────────────────────────────────────────────

const isHandlerRef = (v: WireValue): v is HandlerRef => !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { $handler?: unknown }).$handler === "number";

/** A prop value without handler refs: a ref goes, and so does a menu entry's or an action's `run` with it. */
function stripValue(v: WireValue): WireValue | undefined {
  if (isHandlerRef(v)) return undefined;
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
