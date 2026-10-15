// The element table (docs/56, "The view"): each element of API 1 (protocol API_ELEMENTS)
// and the @cmd/ui component that draws it today. Most are the kit component of the same
// name taking the spec's props as they are (KIT: the sanitised props spread, each of the
// spec's events a function that sends the interaction to the widget's process); the rest
// (ENTRIES) translate. The API's names are the promise and the kit is free to move:
// renaming a kit component changes a line here, not a widget. KIT is typed against the
// spec (KitProps), so a kit component that stops taking an element's props, or an enum
// value, fails tsc; an element added to API_ELEMENTS without a line in either fails too.
// API 1.2's elements that translate are entries-1.2.tsx's (ENTRIES_1_2), each with its reason;
// 1.3's by feature (entries-1.3-layout.tsx: Adapt; entries-1.3-display.tsx: Dial, Stat; entries-1.3-picture.tsx: Picture).

import {
  Badge,
  Button,
  Case,
  CodeBlock,
  Delta,
  Icon,
  IconButton,
  LinkButton,
  ListGroup,
  ListRowActions,
  ListValue,
  Mark,
  Pane,
  Panel,
  PanelBody,
  Panes,
  Ribbon,
  Spinner,
  TimeBar,
  Timeline,
  TimelineEntry,
  Callout,
  Chip,
  EmptyState,
  Hide,
  Inline,
  List,
  ListRow,
  ListRowContent,
  ListRowEnd,
  ListRowIcon,
  ListSection,
  Progress,
  Sparkline,
  Stack,
  StatusDot,
  Text,
  Tiles,
  ToolbarButton,
  ToolbarField,
  ToolbarMenu,
  ToolbarSearchField,
  ToolbarSegmented,
  ToolbarSpacer,
  ToolbarText,
  View,
  WindowToolbar,
  type ViewStateSpec,
} from "@cmd/ui";
import { createElement, memo, startTransition, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { API_ELEMENTS, type ApiElement, type ApiElementOf, type ApiElementSpec, type ApiPropType, type EventValueOf, type OptionOf, type SpecPropsOf, type TreeNode, type WireMenuEntry, type WireValue } from "@cmd/protocol";
import { showContextMenu } from "../../lib/context.ts";
import { setWindowStatus } from "../../lib/windowActions.ts";
import { menuEntries, setChrome } from "./chrome.ts";
import { on, press, str, useDraft, v, type DrawContext, type Drawn } from "./draw.ts";
import { ENTRIES_1_2, type Translated12 } from "./entries-1.2.tsx";
import { ENTRIES_1_3_LAYOUT, type Translated13Layout } from "./entries-1.3-layout.tsx";
import { ENTRIES_1_3_DISPLAY, type Translated13Display } from "./entries-1.3-display.tsx";
import { ENTRIES_1_3_PICTURE, type TranslatedPicture } from "./entries-1.3-picture.tsx";

export type { DrawContext, Drawn } from "./draw.ts";

const visible = (nodes: readonly TreeNode[]) => nodes.filter((n) => n.type === "#text" || !n.props.$hidden);

/** A node, drawn: memoised on the node, so a patch redraws only what it touched (tree.ts copies just that path). */
export const NodeView = memo(function NodeView({ node, ctx }: { node: TreeNode; ctx: DrawContext }): ReactNode {
  if (node.type === "#text") return node.text;
  if (node.props.$hidden) return null;
  const Entry = ELEMENTS[node.type] as ComponentType<Drawn> | undefined;
  if (!Entry) return null;
  return createElement(Entry, { p: node.props, node, ctx, children: drawAll(node.children, ctx) });
});

/** Nodes as React children, keyed by id. */
export function drawAll(nodes: readonly TreeNode[], ctx: DrawContext): ReactNode[] {
  return nodes.map((n) => createElement(NodeView, { key: n.id, node: n, ctx }));
}

/** A View's `state` as the kit's ViewStateSpec, its action a Button that sends `run`. */
function viewState(x: WireValue | undefined, ctx: DrawContext): ViewStateSpec | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const s = x as { kind?: string; icon?: string; title?: string; text?: string; action?: { label: string; run: WireValue } };
  const action = s.action ? <Button onClick={press(ctx, s.action.run, "run")}>{s.action.label}</Button> : undefined;
  switch (s.kind) {
    case "loading":
      return { kind: "loading", title: s.title };
    case "noResults":
      return { kind: "noResults", title: s.title, text: s.text, action };
    case "error":
      return { kind: "error", title: s.title ?? "", text: s.text, action };
    default:
      return { kind: "empty", icon: s.icon, title: s.title ?? "", text: s.text, action };
  }
}

function Field({ p, ctx }: Drawn) {
  const change = on(ctx, p.onChange, "onChange");
  const submit = on(ctx, p.onSubmit, "onSubmit");
  const [draft, setDraft, flush] = useDraft(str(p.value) ?? "", change);
  return (
    <ToolbarField
      value={draft}
      placeholder={str(p.placeholder)}
      icon={str(p.icon)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void flush()}
      onKeyDown={(e) => {
        if (e.key === "Enter") submit?.(flush());
      }}
    />
  );
}

function SearchField({ p, ctx }: Drawn) {
  const submit = on(ctx, p.onSubmit, "onSubmit");
  const [draft, setDraft, flush] = useDraft(str(p.value) ?? "", on(ctx, p.onChange, "onChange"));
  return (
    <ToolbarSearchField
      value={draft}
      placeholder={str(p.placeholder)}
      count={v<string | number>(p.count)}
      onChange={setDraft}
      onKeyDown={(e) => {
        // Return runs the first match (1.3): the text as typed, sent at once.
        if (e.key === "Enter" && submit) submit(flush());
      }}
    />
  );
}

function Segmented({ p, ctx }: Drawn) {
  const change = on(ctx, p.onChange, "onChange");
  // Chosen at once, here; the tree's next value confirms or corrects it.
  const [chosen, setChosen] = useState<string | null>(null);
  const value = str(p.value) ?? "";
  useEffect(() => setChosen(null), [value]);
  const options = (v<OptionOf[]>(p.options) ?? []).map((o) => ({ value: o.value, label: o.label, icon: o.icon }));
  return <ToolbarSegmented value={chosen ?? value} options={options} label={str(p.label) ?? ""} onChange={(x) => (setChosen(x), change?.(x))} />;
}

/**
 * A long list's rows, a window's worth first and the rest over the next frames: the kit's
 * List isn't virtualised, and a thousand rows at once take far longer than a frame
 * (docs/56: a thousand ListRows under 50 ms). Rows past the first FIRST draw as transitions,
 * so a click or a patch never waits for them.
 */
const FIRST = 60;
const STEP = 100;
function useProgressive(count: number): number {
  const [shown, setShown] = useState(() => Math.min(count, FIRST));
  useEffect(() => {
    if (shown >= count) return;
    const frame = requestAnimationFrame(() => startTransition(() => setShown((s) => Math.min(count, s + STEP))));
    return () => cancelAnimationFrame(frame);
  }, [shown, count]);
  return Math.max(Math.min(shown, count), Math.min(count, FIRST));
}

/** Rows (and sections), drawn progressively when there are many. */
function Rows({ nodes, ctx }: { nodes: readonly TreeNode[]; ctx: DrawContext }) {
  const shown = useProgressive(nodes.length);
  return <>{drawAll(shown < nodes.length ? nodes.slice(0, shown) : nodes, ctx)}</>;
}

/** The widget's own window: the status line and the menus go to the title bar (chrome.ts); its children are the content. */
function WindowEntry({ p, ctx, children }: Drawn) {
  const status = str(p.status) ?? null;
  useEffect(() => setWindowStatus(ctx.windowId, status ? { label: status, key: "summary" } : null), [ctx.windowId, status]);
  useEffect(() => () => setWindowStatus(ctx.windowId, null), [ctx.windowId]);
  const menu = v<WireMenuEntry[]>(p.menu) ?? null;
  const actions = v<WireMenuEntry[]>(p.actions) ?? null;
  const menuLabel = str(p.menuLabel) ?? null;
  useEffect(() => setChrome(ctx.windowId, { menu, menuLabel, actions, send: ctx.send }), [ctx, menu, menuLabel, actions]);
  useEffect(() => () => setChrome(ctx.windowId, null), [ctx.windowId]);
  return <>{children}</>;
}

/** A View: its top WindowToolbars become the toolbar, a bottom one sits under the content (a player's bar); a StatusLine is its footer (1.2). */
function ViewEntry({ p, node, ctx }: Drawn) {
  const kids = visible(node.children);
  const top = kids.filter((c) => c.type === "WindowToolbar" && !c.props.bottom);
  const foot = kids.filter((c) => c.type === "StatusLine");
  const rest = kids.filter((c) => !top.includes(c) && !foot.includes(c));
  return (
    <View inset={p.inset === true} scroll={p.scroll !== false} state={viewState(p.state, ctx)} toolbar={top.length ? drawAll(top, ctx) : undefined} footer={foot.length ? drawAll(foot, ctx) : undefined}>
      {drawAll(rest, ctx)}
    </View>
  );
}

/** An event as the kit's handler: a pick passes its value (a row's key, a bucket), the others nothing. */
type KitEvent<S> = S extends { gesture: "pick" } ? (value: Exclude<EventValueOf<S>, undefined>) => void : () => void;
/** An element's props as the kit takes them: the spec's values, each event a function (with a pick's value), its children (drawn) when it holds any. */
export type KitProps<E extends ApiElement> = SpecPropsOf<E> & { [K in keyof ApiElementOf<E>["events"] & string]?: KitEvent<ApiElementOf<E>["events"][K]> } & (ApiElementOf<E>["children"] extends "none" ? unknown : { children: ReactNode });

/** The elements that translate (ENTRIES, ENTRIES_1_2); every other one is its kit component (KIT). */
type Translated = "Window" | "View" | "ToolbarField" | "ToolbarSearchField" | "ToolbarSegmented" | "ToolbarMenu" | "ListRow" | "EmptyState" | Translated12 | Translated13Layout | Translated13Display | TranslatedPicture;

/**
 * The elements the kit component of the same name draws from the spec's props as they are.
 * The `satisfies` is the check that the spec and the kit agree: each element's props
 * (KitProps, derived from API_ELEMENTS) must be props the component takes.
 */
const KIT = {
  WindowToolbar,
  ToolbarButton,
  ToolbarText,
  ToolbarSpacer,
  Stack,
  Inline,
  Tiles,
  Hide,
  List,
  ListSection,
  ListRowIcon,
  ListRowContent,
  ListRowEnd,
  Chip,
  Sparkline,
  Text,
  Badge,
  StatusDot,
  Button,
  Callout,
  Progress,
  // 1.2
  Panes,
  Pane,
  Panel,
  PanelBody,
  ListGroup,
  ListRowActions,
  ListValue,
  CodeBlock,
  Icon,
  Mark,
  Delta,
  Spinner,
  IconButton,
  LinkButton,
  TimeBar,
  Timeline,
  TimelineEntry,
  Ribbon,
  // 1.3
  Case,
} satisfies { [E in Exclude<ApiElement, Translated>]: (props: KitProps<E>) => ReactNode };

/** What a required prop the sanitiser dropped is drawn as. */
function empty(type: ApiPropType): WireValue | undefined {
  if (type === "string" || type === "text") return "";
  if (type === "numbers") return [];
  return undefined;
}

/** The elements whose children are rows: drawn progressively. */
const ROWS = new Set<ApiElement>(["List", "ListSection", "ListGroup"]);

/** A kit component drawn from the spec: the sanitised props, the spec's events as presses, the children when it holds any. */
function passThrough(name: keyof typeof KIT): ComponentType<Drawn> {
  const Kit = KIT[name] as ComponentType<Record<string, unknown>>;
  const spec: ApiElementSpec = API_ELEMENTS[name];
  function Entry({ p, node, ctx, children }: Drawn) {
    const props: Record<string, unknown> = {};
    for (const [k, s] of Object.entries(spec.props)) props[k] = p[k] ?? (s.required ? empty(s.type) : undefined);
    // A pick passes on the value the kit gives it (a bar's id, a time); other events none of the DOM's.
    for (const [k, e] of Object.entries(spec.events)) props[k] = e.gesture === "pick" ? on(ctx, p[k], k) : press(ctx, p[k], k);
    if (spec.children !== "none") props.children = ROWS.has(name) ? <Rows nodes={node.children} ctx={ctx} /> : children;
    return createElement(Kit, props);
  }
  Entry.displayName = name;
  return Entry;
}

/** The elements that translate: the title bar, the view's toolbar and states, the toolbar's fields (a draft kept here), menus and actions. */
const ENTRIES: { readonly [K in Exclude<Translated, Translated12 | Translated13Layout | Translated13Display | TranslatedPicture>]: ComponentType<Drawn> } = {
  Window: WindowEntry,
  View: ViewEntry,
  ToolbarField: Field,
  ToolbarSearchField: SearchField,
  ToolbarSegmented: Segmented,
  // A menu on the wire, opened as the app's.
  ToolbarMenu: ({ p, ctx }) => {
    const label = str(p.label) ?? "";
    return (
      <ToolbarMenu label={label} icon={str(p.icon)} disabled={p.disabled === true} priority={v<number>(p.priority)} secondary={p.secondary === true} onClick={() => void showContextMenu(menuEntries(v<WireMenuEntry[]>(p.menu), ctx.send))}>
        {label}
      </ToolbarMenu>
    );
  },
  // Keyed for the kit's row motion, its menu the app's context menu.
  ListRow: ({ p, node, ctx, children }) => {
    const menu = v<WireMenuEntry[]>(p.menu);
    return (
      <ListRow
        flipKey={String(node.id)}
        selected={p.selected === true}
        dim={p.dim === true}
        depth={v<number>(p.depth)}
        tip={str(p.tip)}
        reveal={p.reveal === true}
        onClick={press(ctx, p.onClick, "onClick")}
        onDoubleClick={press(ctx, p.onDoubleClick, "onDoubleClick")}
        onContextMenu={menu?.length ? () => void showContextMenu(menuEntries(menu, ctx.send)) : undefined}
      >
        {children}
      </ListRow>
    );
  },
  // The action is a Button; the text is the kit's children.
  EmptyState: ({ p, ctx }) => {
    const a = v<{ label: string; run: WireValue }>(p.action);
    return (
      <EmptyState icon={str(p.icon)} title={str(p.title)} compact={p.compact === true} action={a ? <Button onClick={press(ctx, a.run, "run")}>{a.label}</Button> : undefined}>
        {str(p.text)}
      </EmptyState>
    );
  },
};

/** Every element of API 1 and what draws it. */
export const ELEMENTS: { readonly [K in ApiElement]: ComponentType<Drawn> } = {
  ...(Object.fromEntries(Object.keys(KIT).map((k) => [k, passThrough(k as keyof typeof KIT)])) as { [K in keyof typeof KIT]: ComponentType<Drawn> }),
  ...ENTRIES,
  ...ENTRIES_1_2,
  ...ENTRIES_1_3_LAYOUT,
  ...ENTRIES_1_3_DISPLAY,
  ...ENTRIES_1_3_PICTURE,
};
