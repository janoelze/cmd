// The element table (docs/56, "The view"): each element of API 1 (protocol API_ELEMENTS)
// and the @cmd/ui component that draws it today, with its props translated. The tree's
// props arrive sanitised (tree.ts); a handler ref becomes a function that sends the
// interaction to the widget's process. The API's names are the promise and the kit is
// free to move: renaming a kit component changes a line here, not a widget. The table is
// typed over ApiElement, so an element added to API_ELEMENTS without an entry fails tsc.

import {
  Badge,
  Button,
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
  Stat,
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
import { createElement, memo, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import type { ApiElement, TreeElement, TreeNode, WireMenuEntry, WireValue, WindowId } from "@cmd/protocol";
import { showContextMenu } from "../../lib/context.ts";
import { setWindowStatus } from "../../lib/windowActions.ts";
import { menuEntries, setChrome, type Send } from "./chrome.ts";
import { isHandler } from "./tree.ts";

/** What every element is drawn with: its window and the way back to its process. */
export interface DrawContext {
  windowId: WindowId;
  send: Send;
}

/** An entry's input: the element's (sanitised) props, its children drawn, and the node. */
export interface Drawn {
  p: Record<string, WireValue>;
  children: ReactNode;
  node: TreeElement;
  ctx: DrawContext;
}

/** A prop as the kit's type (the sanitiser checked it against API_ELEMENTS). */
const v = <T,>(x: WireValue | undefined): T | undefined => (x === null || x === undefined ? undefined : (x as T));
const str = (x: WireValue | undefined) => (typeof x === "string" ? x : undefined);
const words = (x: WireValue | undefined) => (typeof x === "string" || typeof x === "number" ? x : undefined);

/** A handler prop as a function sending its interaction; undefined without one. */
function on(ctx: DrawContext, ref: WireValue | undefined, event: string): ((value?: WireValue) => void) | undefined {
  return isHandler(ref) ? (value?: WireValue) => ctx.send(ref.$handler, event, value) : undefined;
}
/** The same, for the kit's handlers that pass a DOM event: none of it crosses. */
function press(ctx: DrawContext, ref: WireValue | undefined, event: string): (() => void) | undefined {
  const fn = on(ctx, ref, event);
  return fn && (() => fn());
}

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

/** A text the person types into: the caret stays here, the value goes to the process debounced (docs/56). */
const DEBOUNCE_MS = 150;
function useDraft(value: string, send: ((v: string) => void) | undefined): [string, (v: string) => void, () => string] {
  const [draft, setDraft] = useState(value);
  const sent = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(value);
  // The tree's value wins when it changes to something this field didn't send (the widget cleared it).
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      latest.current = value;
      setDraft(value);
    }
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flush = () => {
    clearTimeout(timer.current);
    if (latest.current !== sent.current) {
      sent.current = latest.current;
      send?.(latest.current);
    }
    return latest.current;
  };
  const change = (next: string) => {
    latest.current = next;
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, DEBOUNCE_MS);
  };
  return [draft, change, flush];
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
  const [draft, setDraft] = useDraft(str(p.value) ?? "", on(ctx, p.onChange, "onChange"));
  return <ToolbarSearchField value={draft} placeholder={str(p.placeholder)} count={words(p.count)} onChange={setDraft} />;
}

function Segmented({ p, ctx }: Drawn) {
  const change = on(ctx, p.onChange, "onChange");
  // Chosen at once, here; the tree's next value confirms or corrects it.
  const [chosen, setChosen] = useState<string | null>(null);
  const value = str(p.value) ?? "";
  useEffect(() => setChosen(null), [value]);
  const options = (v<{ value: string; label: string; icon?: string }[]>(p.options) ?? []).map((o) => ({ value: o.value, label: o.label, icon: o.icon }));
  return <ToolbarSegmented value={chosen ?? value} options={options} label={str(p.label) ?? ""} onChange={(x) => (setChosen(x), change?.(x))} />;
}

/** The widget's own window: the status line and the menus go to the title bar (chrome.ts); its children are the content. */
function WindowEntry({ p, ctx, children }: Drawn) {
  const status = str(p.status) ?? null;
  useEffect(() => setWindowStatus(ctx.windowId, status ? { label: status, key: "summary" } : null), [ctx.windowId, status]);
  useEffect(() => () => setWindowStatus(ctx.windowId, null), [ctx.windowId]);
  const menu = v<WireMenuEntry[]>(p.menu) ?? null;
  const actions = v<WireMenuEntry[]>(p.actions) ?? null;
  useEffect(() => setChrome(ctx.windowId, { menu, actions, send: ctx.send }), [ctx, menu, actions]);
  useEffect(() => () => setChrome(ctx.windowId, null), [ctx.windowId]);
  return <>{children}</>;
}

/** A View: its top WindowToolbars become the toolbar, a bottom one sits under the content (a player's bar). */
function ViewEntry({ p, node, ctx }: Drawn) {
  const kids = visible(node.children);
  const top = kids.filter((c) => c.type === "WindowToolbar" && !c.props.bottom);
  const rest = kids.filter((c) => !top.includes(c));
  return (
    <View inset={p.inset === true} scroll={p.scroll !== false} state={viewState(p.state, ctx)} toolbar={top.length ? drawAll(top, ctx) : undefined}>
      {drawAll(rest, ctx)}
    </View>
  );
}

/** Every element of API 1 and what draws it. */
export const ELEMENTS: { readonly [K in ApiElement]: ComponentType<Drawn> } = {
  Window: WindowEntry,
  View: ViewEntry,
  WindowToolbar: ({ p, children }) => (
    <WindowToolbar label={str(p.label)} bottom={p.bottom === true}>
      {children}
    </WindowToolbar>
  ),
  ToolbarButton: ({ p, ctx }) => (
    <ToolbarButton
      label={str(p.label) ?? ""}
      icon={str(p.icon)}
      showLabel={p.showLabel === true}
      pressed={v<boolean>(p.pressed)}
      disabled={p.disabled === true}
      tone={v<"accent" | "danger" | "needs">(p.tone)}
      badge={words(p.badge)}
      tip={str(p.tip)}
      priority={v<number>(p.priority)}
      secondary={p.secondary === true}
      onClick={press(ctx, p.onClick, "onClick")}
    />
  ),
  ToolbarField: Field,
  ToolbarSearchField: SearchField,
  ToolbarSegmented: Segmented,
  ToolbarMenu: ({ p, ctx }) => {
    const label = str(p.label) ?? "";
    return (
      <ToolbarMenu label={label} icon={str(p.icon)} disabled={p.disabled === true} priority={v<number>(p.priority)} secondary={p.secondary === true} onClick={() => void showContextMenu(menuEntries(v<WireMenuEntry[]>(p.menu), ctx.send))}>
        {label}
      </ToolbarMenu>
    );
  },
  ToolbarText: ({ p, children }) => (
    <ToolbarText priority={v<number>(p.priority)} secondary={p.secondary === true}>
      {children}
    </ToolbarText>
  ),
  ToolbarSpacer: () => <ToolbarSpacer />,
  Stack: ({ p, children }) => (
    <Stack gap={v(p.gap)} pad={v(p.pad)} padY={v(p.padY)} align={v(p.align)} grow={p.grow === true}>
      {children}
    </Stack>
  ),
  Inline: ({ p, children }) => (
    <Inline gap={v(p.gap)} align={v(p.align)} justify={v(p.justify)} wrap={p.wrap === true} grow={p.grow === true}>
      {children}
    </Inline>
  ),
  Tiles: ({ p, children }) => (
    <Tiles min={v(p.min)} gap={v(p.gap)}>
      {children}
    </Tiles>
  ),
  Hide: ({ p, children }) => (
    <Hide below={v(p.below)} above={v(p.above)}>
      {children}
    </Hide>
  ),
  List: ({ children }) => <List>{children}</List>,
  ListSection: ({ p, ctx, children }) => (
    <ListSection title={str(p.title) ?? ""} count={v<number>(p.count)} open={v<boolean>(p.open)} tone={v(p.tone)} onToggle={press(ctx, p.onToggle, "onToggle")}>
      {children}
    </ListSection>
  ),
  ListRow: ({ p, node, ctx, children }) => {
    const menu = v<WireMenuEntry[]>(p.menu);
    return (
      <ListRow
        flipKey={String(node.id)}
        selected={p.selected === true}
        dim={p.dim === true}
        depth={v<number>(p.depth)}
        tip={str(p.tip)}
        onClick={press(ctx, p.onClick, "onClick")}
        onDoubleClick={press(ctx, p.onDoubleClick, "onDoubleClick")}
        onContextMenu={menu?.length ? () => void showContextMenu(menuEntries(menu, ctx.send)) : undefined}
      >
        {children}
      </ListRow>
    );
  },
  ListRowIcon: ({ p }) => <ListRowIcon icon={str(p.icon) ?? ""} light={v(p.light)} tone={v(p.tone)} />,
  ListRowContent: ({ p }) => <ListRowContent title={words(p.title)} place={words(p.place)} detail={words(p.detail)} tone={v(p.tone)} mono={p.mono === true} />,
  ListRowEnd: ({ children }) => <ListRowEnd>{children}</ListRowEnd>,
  Chip: ({ p, children }) => (
    // Without a hue, the kit's neutral one (its CSS default).
    <Chip hue={v<number>(p.hue) as number} tip={str(p.tip)}>
      {children}
    </Chip>
  ),
  Stat: ({ p, ctx }) => <Stat label={str(p.label) ?? ""} value={words(p.value) ?? ""} unit={str(p.unit)} delta={words(p.delta)} deltaTone={v(p.deltaTone)} onSelect={press(ctx, p.onSelect, "onSelect")} />,
  Sparkline: ({ p }) => <Sparkline values={v<(number | null)[]>(p.values) ?? []} height={v(p.height)} area={v(p.area)} color={v(p.color)} />,
  Text: ({ p, children }) => (
    <Text tone={v(p.tone)} size={v(p.size)} mono={p.mono === true} strong={p.strong === true} truncate={p.truncate === true} select={p.select === true} balance={p.balance === true}>
      {children}
    </Text>
  ),
  Badge: ({ p, children }) => (
    <Badge tone={v(p.tone)} size={v(p.size)} solid={p.solid === true} tip={str(p.tip)}>
      {children}
    </Badge>
  ),
  StatusDot: ({ p }) => <StatusDot state={v(p.state)} size={v(p.size)} label={str(p.label)} />,
  Button: ({ p, ctx, children }) => (
    <Button variant={v(p.variant)} size={v(p.size)} icon={str(p.icon)} pressed={v<boolean>(p.pressed)} busy={p.busy === true} disabled={p.disabled === true} onClick={press(ctx, p.onClick, "onClick")}>
      {children}
    </Button>
  ),
  EmptyState: ({ p, ctx }) => {
    const a = v<{ label: string; run: WireValue }>(p.action);
    return (
      <EmptyState icon={str(p.icon)} title={str(p.title)} compact={p.compact === true} action={a ? <Button onClick={press(ctx, a.run, "run")}>{a.label}</Button> : undefined}>
        {str(p.text)}
      </EmptyState>
    );
  },
  Callout: ({ p, ctx, children }) => (
    <Callout tone={v(p.tone)} title={str(p.title)} icon={str(p.icon)} compact={p.compact === true} banner={p.banner === true} onDismiss={press(ctx, p.onDismiss, "onDismiss")}>
      {children}
    </Callout>
  ),
  Progress: ({ p }) => <Progress value={v<number>(p.value)} tone={v(p.tone)} label={str(p.label)} />,
};
