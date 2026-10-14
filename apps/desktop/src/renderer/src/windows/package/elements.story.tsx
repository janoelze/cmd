// Every element of the widget API (docs/56, API 1) drawn by the package view, from a fixed
// tree as a widget's process would send it: one variant per element of API_ELEMENTS, then
// the example widget (packages/widget-api/examples/v1/agents.tsx) running against the fake
// host, a thousand rows, and the window's states. The title bar shows what the tree's
// Window gives it (status line, title menu).

import { Window as Frame, WindowBar, WindowBarMenu, WindowBody, WindowFrame } from "@cmd/ui";
import { useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";
import type { TreeNode, WidgetOut, WireValue } from "@cmd/protocol";
import { run } from "@cmd/widget-api/runtime";
import { createHost } from "@cmd/widget-api/testing/host";
import { agent } from "@cmd/widget-api/testing/fixtures";
import AgentActivity from "@cmd/widget-api/examples/v1/agents.tsx";
import { SIZES, type SizeName } from "../../reference/RefWindow.tsx";
import { useWindowStatus } from "../../lib/windowActions.ts";
import { showContextMenu } from "../../lib/context.ts";
import { useWindowChrome } from "../registry.ts";
import { chromeOf, menuEntries, menuLabel } from "./chrome.ts";
import { PackageWidget } from "./PackageView.tsx";
import type { WidgetLink } from "./live.ts";
import { TreeStore, type TreeMessage } from "./tree.ts";

// ── a tree, as data ─────────────────────────────────────

let nextId = 1;
let nextHandler = 1;
/** An element of the tree; strings among the children are its words. */
const e = (type: string, props: Record<string, WireValue> = {}, ...children: (TreeNode | string)[]): TreeNode => ({
  id: nextId++,
  type: type as never,
  props,
  children: children.map((c) => (typeof c === "string" ? { id: nextId++, type: "#text", text: c } : c)),
});
/** A handler ref, as the reconciler makes one for a function prop. */
const h = (): WireValue => ({ $handler: nextHandler++ });
const row = (title: string, { light = "working", ...more }: Record<string, WireValue> = {}, end?: TreeNode) =>
  e("ListRow", { onClick: h(), menu: [{ label: "Mark Seen", run: h() }] }, e("ListRowIcon", { icon: "sparkle", light }), e("ListRowContent", { title, ...more }), ...(end ? [e("ListRowEnd", {}, end)] : []));

// ── the window around it ────────────────────────────────

let windows = 0;
const quiet: WidgetLink = { interact: () => {}, resync: () => {}, restart: () => {}, env: () => {} };

/** A widget's window at a reference size, with the title bar its Window fills. */
function Widget({ messages, size = "regular", name = "Example", link = quiet, store: given }: { messages?: TreeMessage[]; size?: SizeName; name?: string; link?: WidgetLink; store?: TreeStore }) {
  const id = useMemo(() => `story-widget-${++windows}`, []);
  const store = useMemo(() => {
    if (given) return given;
    const s = new TreeStore({ resync: () => {} });
    for (const m of messages ?? []) s.apply(m);
    return s;
  }, [given, messages]);
  const [width, height] = SIZES[size];
  return (
    <Frame selected style={{ width, height, position: "relative", flex: "none" }}>
      <WindowBody style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <Bar id={id} name={name} />
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <PackageWidget windowId={id} store={store} link={link} />
        </div>
      </WindowBody>
      <WindowFrame />
    </Frame>
  );
}

function Bar({ id, name }: { id: string; name: string }) {
  useWindowChrome();
  const status = useWindowStatus(id);
  const c = chromeOf(id);
  return (
    <WindowBar icon="puzzlepiece.extension" name={name}>
      <span className="ui-window-bar-meta">{status?.label}</span>
      {c?.menu?.length ? <WindowBarMenu onClick={() => void showContextMenu(menuEntries(c.menu, c.send))}>{menuLabel(c.menu)}</WindowBarMenu> : null}
    </WindowBar>
  );
}

/** The tree inside a View, as most widgets send it. */
const tree = (...nodes: TreeNode[]): TreeMessage[] => [{ kind: "tree", rev: 1, nodes }];
const inView = (...nodes: TreeNode[]) => tree(e("View", { inset: true }, e("Stack", { gap: 3 }, ...nodes)));
const W = ({ nodes, size }: { nodes: TreeMessage[]; size?: SizeName }) => <Widget messages={nodes} size={size} />;

// ── one variant per element ─────────────────────────────

/** The widget's window: a status line and a title menu in the title bar, the content below. */
export const Window = () => (
  <W
    nodes={tree(
      e("Window", { status: "2 waiting for you · 1 working", menu: [{ label: "This Workspace", checked: true, run: h() }, { label: "All Workspaces", checked: false, run: h() }], actions: [{ label: "Refresh", run: h() }] }, e("View", { inset: true }, e("Text", {}, "The title bar says what this Window's status and menu are."))),
    )}
  />
);

/** A View with its states: the body, and an empty state with its one action. */
export const View = () => (
  <div style={{ display: "flex", gap: 16 }}>
    <W nodes={inView(e("Text", {}, "A padded body."))} />
    <W nodes={tree(e("View", { state: { kind: "empty", icon: "person.2", title: "No agents", text: "Start one with ⌥⌘N.", action: { label: "New Claude Session", run: h() } } }))} />
  </div>
);

const toolbar = (...items: TreeNode[]) => tree(e("View", {}, e("WindowToolbar", { label: "Filter" }, ...items), e("List", {}, row("Tours"), row("Perf"))));

/** A toolbar over the content, its items giving way as the window narrows. */
export const WindowToolbar = () => <W nodes={toolbar(e("ToolbarButton", { label: "Refresh", icon: "arrow.clockwise", onClick: h() }), e("ToolbarSpacer"), e("ToolbarText", {}, "2 of 12"))} />;
/** Buttons: icon, labelled, pressed, toned with a badge. */
export const ToolbarButton = () => (
  <W
    nodes={toolbar(
      e("ToolbarButton", { label: "Refresh", icon: "arrow.clockwise", onClick: h() }),
      e("ToolbarButton", { label: "Run", icon: "play.fill", showLabel: true, onClick: h() }),
      e("ToolbarButton", { label: "Pin", icon: "pin", pressed: true, onClick: h() }),
      e("ToolbarButton", { label: "Failures", icon: "xmark.octagon", tone: "danger", badge: 3, onClick: h() }),
      e("ToolbarButton", { label: "Clear", onClick: h(), secondary: true }),
    )}
  />
);
/** A text field: typed here, sent debounced. */
export const ToolbarField = () => <W nodes={toolbar(e("ToolbarField", { value: "main", placeholder: "Branch", icon: "arrow.triangle.branch", onChange: h(), onSubmit: h() }))} />;
/** A filter field with its count. */
export const ToolbarSearchField = () => <W nodes={toolbar(e("ToolbarSearchField", { value: "to", placeholder: "Filter agents", count: "1 of 2", onChange: h() }))} />;
/** A few choices side by side. */
export const ToolbarSegmented = () => <W nodes={toolbar(e("ToolbarSegmented", { value: "day", label: "Range", options: [{ value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }], onChange: h() }))} />;
/** A button that opens a menu. */
export const ToolbarMenu = () => <W nodes={toolbar(e("ToolbarMenu", { label: "main", icon: "arrow.triangle.branch", menu: [{ label: "main", checked: true, run: h() }, { separator: true }, { label: "release", run: h() }] }))} />;
/** Words in a toolbar. */
export const ToolbarText = () => <W nodes={toolbar(e("ToolbarText", {}, "Updated by the widget"))} />;
/** Pushes what follows to the end. */
export const ToolbarSpacer = () => <W nodes={toolbar(e("ToolbarText", {}, "Start"), e("ToolbarSpacer"), e("ToolbarText", {}, "End"))} />;

/** A column of children. */
export const Stack = () => <W nodes={inView(e("Stack", { gap: 1 }, e("Text", { strong: true }, "Deploy"), e("Text", { tone: "dim" }, "Last run 4 min ago")))} />;
/** A row of children. */
export const Inline = () => <W nodes={inView(e("Inline", { gap: 2, justify: "between" }, e("Badge", { tone: "success" }, "passed"), e("Text", { tone: "dim", size: "sm" }, "12 s")))} />;
/** Equal tiles, as many as fit. */
export const Tiles = () => <W nodes={inView(e("Tiles", { min: 120 }, e("Stat", { label: "Waiting", value: 2 }), e("Stat", { label: "Working", value: 3 }), e("Stat", { label: "Done", value: 14 })))} />;
/** What only shows when there is room. */
export const Hide = () => <W nodes={inView(e("Text", {}, "Always here."), e("Hide", { below: "regular" }, e("Text", { tone: "dim" }, "Hidden in a narrow window.")))} />;

const listTree = () =>
  tree(
    e("View", {}, e("List", {}, e("ListSection", { title: "Waiting for you", count: 1, tone: "needs" }, row("Tours", { detail: "Wants to run pnpm e2e", tone: "needs", light: "needs" }, e("Chip", {}, "2m"))), e("ListSection", { title: "Working", count: 2, onToggle: h() }, row("Perf", { place: "cmd-perf" }, e("Chip", {}, "now")), e("ListRow", { depth: 1, onClick: h() }, e("ListRowIcon", { icon: "sparkle", light: "working" }), e("ListRowContent", { title: "Explore · the tracker's callers" }))))),
  );
/** Rows and sections. */
export const List = () => <W nodes={listTree()} />;
/** A heading with a count, in the needs tone; a section folded. */
export const ListSection = () => <W nodes={tree(e("View", {}, e("List", {}, e("ListSection", { title: "Waiting for you", count: 1, tone: "needs" }, row("Tours")), e("ListSection", { title: "Done", count: 4, open: false, onToggle: h() }, row("Docs")))))} />;
/** Rows: selected, dim, under another, with a context menu. */
export const ListRow = () => <W nodes={tree(e("View", {}, e("List", {}, e("ListRow", { selected: true, onClick: h() }, e("ListRowContent", { title: "Selected" })), e("ListRow", { dim: true, onClick: h() }, e("ListRowContent", { title: "Dim" })), e("ListRow", { depth: 1, tip: "Under the row above", onClick: h() }, e("ListRowContent", { title: "Nested" })))))} />;
/** An icon, or a status light in its place. */
export const ListRowIcon = () => <W nodes={tree(e("View", {}, e("List", {}, ...(["needs", "working", "done", "idle", "off", "danger"] as const).map((l) => e("ListRow", {}, e("ListRowIcon", { icon: "sparkle", light: l }), e("ListRowContent", { title: l }))))))} />;
/** A title with a place, or with a detail line. */
export const ListRowContent = () => <W nodes={tree(e("View", {}, e("List", {}, row("One line", { place: "cmd-perf" }), row("Two lines", { detail: "Editing packages/core/src/agents/tracker.ts" }), row("packages/ui/src/list.tsx", { mono: true }))))} />;
/** What sits at a row's end. */
export const ListRowEnd = () => <W nodes={tree(e("View", {}, e("List", {}, row("Chip", {}, e("Chip", {}, "4m")), row("Badge", {}, e("Badge", { size: "sm", tone: "danger" }, "failed")))))} />;
/** Small pills of text, neutral or in a hue. */
export const Chip = () => <W nodes={inView(e("Inline", {}, e("Chip", {}, "now"), e("Chip", { hue: 140, tip: "Branch" }, "main"), e("Chip", { hue: 20 }, "release")))} />;

/** Numbers with their labels, a change, one pressable. */
export const Stat = () => <W nodes={inView(e("Inline", { gap: 6 }, e("Stat", { label: "Waiting", value: 2, onSelect: h() }), e("Stat", { label: "p95", value: 412, unit: "ms", delta: "+12%", deltaTone: "danger" })))} />;
/** Recent values as a line. */
export const Sparkline = () => <W nodes={inView(e("Sparkline", { values: [3, 5, 4, 8, 6, null, 7, 9, 12, 10], height: 32 }), e("Sparkline", { values: [1, 2, 1, 3, 2, 4], color: "neutral", area: false }))} />;
/** Words, in tones and sizes. */
export const Text = () => <W nodes={inView(e("Text", { size: "lg", strong: true }, "A heading"), e("Text", {}, "A paragraph of plain words, wrapped as the window allows."), e("Text", { tone: "dim", size: "sm" }, "Dim, small"), e("Text", { mono: true, select: true }, "~/src/cmd"))} />;
/** Labels in a tone. */
export const Badge = () => <W nodes={inView(e("Inline", {}, ...(["neutral", "accent", "success", "warning", "danger"] as const).map((t) => e("Badge", { tone: t }, t)), e("Badge", { tone: "danger", solid: true }, "3 new")))} />;
/** Status lights. */
export const StatusDot = () => <W nodes={inView(e("Inline", { gap: 3 }, ...(["needs", "working", "done", "idle", "off", "success", "danger"] as const).map((s) => e("StatusDot", { state: s, label: s }))))} />;
/** Buttons: default, primary, danger, ghost, busy, disabled. */
export const Button = () => <W nodes={inView(e("Inline", { wrap: true }, e("Button", { onClick: h() }, "Refresh"), e("Button", { variant: "primary", icon: "play.fill", onClick: h() }, "Run"), e("Button", { variant: "danger", onClick: h() }, "Stop"), e("Button", { variant: "ghost", onClick: h() }, "Later"), e("Button", { busy: true }, "Saving"), e("Button", { disabled: true }, "Off")))} />;
/** What a view shows when it has nothing. */
export const EmptyState = () => <W nodes={tree(e("View", {}, e("EmptyState", { icon: "checkmark.seal", title: "No runs yet", text: "Runs show up here as CI starts them.", action: { label: "Open Actions", run: h() } })))} />;
/** Notes in a tone: a warning with a dismiss, an error, a compact tip. */
export const Callout = () => <W nodes={inView(e("Callout", { tone: "warning", title: "Token expires soon", onDismiss: h() }, e("Text", {}, "Renew it in the widget's settings.")), e("Callout", { tone: "danger", title: "HTTP 403" }), e("Callout", { tone: "accent", compact: true }, e("Text", {}, "Double-click a row to open it.")))} />;
/** A bar: part done, indeterminate. */
export const Progress = () => <W nodes={inView(e("Progress", { value: 0.4, label: "Deploying" }), e("Progress", { tone: "success", value: 1 }), e("Progress", { label: "Waiting" }))} />;

// ── the example widget, and the window's states ────────

/** packages/widget-api/examples/v1/agents.tsx, running in the widget runtime against the fake host: its tree is what the view draws. */
export const ExampleAgents = () => {
  const [store] = useState(() => new TreeStore({ resync: () => {} }));
  const [link, setLink] = useState<WidgetLink | null>(null);
  useEffect(() => {
    const host = createHost({
      agents: [
        agent({ name: "Tours", state: "waiting", statusLine: "Wants to run pnpm e2e", place: "cmd-tours" }),
        agent({ name: "Perf", state: "working", statusLine: "Running the stress test", place: "cmd-perf" }),
        agent({ name: "Explore", state: "working", depth: 1, parentId: "a-perf" }),
        agent({ name: "Docs", state: "done", statusLine: "Wrote the API reference", place: "cmd" }),
      ],
    });
    const transport = {
      send: (m: WidgetOut) => {
        if (m.kind === "tree" || m.kind === "patch") store.apply(m);
        host.transport.send(m);
      },
      listen: host.transport.listen,
    };
    const running = run(transport, AgentActivity, { package: "agents", version: "1.0.0", widget: "agents" });
    setLink({ interact: (handler, event, value) => host.deliver({ kind: "interaction", handler, event, ...(value === undefined ? {} : { value }) }), resync: () => host.deliver({ kind: "resync" }), restart: () => {}, env: () => {} });
    return () => void running.then((r) => r.stop());
  }, [store]);
  return link ? <Widget store={store} link={link} name="Agent Activity" /> : null;
};

/**
 * A thousand rows in one tree (the view's budget: drawn in under 50 ms). The tree arrives
 * after the first paint, as a widget's does; the time it took to draw is on the page's
 * body as data-widget-rows-ms (`pnpm workbench eval` reads it).
 */
export const ThousandRows = () => {
  const [store] = useState(() => new TreeStore({ resync: () => {} }));
  useEffect(() => {
    const message = tree(e("View", {}, e("List", {}, ...Array.from({ length: 1000 }, (_, i) => row(`Agent ${i}`, { detail: i % 3 ? "Working" : "Waiting for you" }, e("Chip", {}, `${i % 60}m`))))))[0]!;
    // Outside the commit, so flushSync draws it there and then: the time is React's render and commit of the tree.
    const t = setTimeout(() => {
      const t0 = performance.now();
      flushSync(() => store.apply(message));
      document.body.dataset.widgetRowsMs = (performance.now() - t0).toFixed(1);
      // Then the rest, a frame at a time: when all are there, and the longest frame on the way.
      let last = performance.now();
      let longest = 0;
      const tick = () => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
        const rows = store.snapshot.loaded ? document.querySelectorAll("[data-thousand] .ui-list-row").length : 0;
        if (rows < 1000) return void requestAnimationFrame(tick);
        document.body.dataset.widgetRowsAllMs = (now - t0).toFixed(0);
        document.body.dataset.widgetRowsFrameMs = longest.toFixed(0);
      };
      requestAnimationFrame(tick);
    });
    return () => clearTimeout(t);
  }, [store]);
  return (
    <div data-thousand>
      <Widget store={store} size="wide" />
    </div>
  );
};

/** The process's states: starting, stopped with Restart, waiting for permission; and a tree the kit couldn't draw. */
export const States = () => (
  <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
    <Widget messages={[]} size="narrow" />
    <Widget messages={[{ kind: "status", state: "stopped", reason: "crashed" }]} size="narrow" />
    <Widget messages={[{ kind: "status", state: "waiting-grant" }]} size="narrow" />
  </div>
);

/** The same widget at each reference size. */
export const Sizes = () => (
  <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
    {(["narrow", "regular", "wide"] as const).map((s) => (
      <Widget key={s} messages={listTree()} size={s} />
    ))}
  </div>
);

