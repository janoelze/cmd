// Every element of the widget API (docs/56, API 1; 1.2's from docs/57) drawn by the package view, from a fixed
// tree as a widget's process would send it: one variant per element of API_ELEMENTS (Frame's
// page inline, frame-chart.html, as a live window would serve its package's; 1.3's Adapt and
// Case at three window sizes), then
// the example widget (packages/widget-api/examples/v1/agents.tsx) running against the fake
// host, a thousand rows, and the window's states. The title bar shows what the tree's
// Window gives it (status line, title menu). 1.3's display pieces run in the example
// widgets countdown.tsx and usage.tsx, each beside the native view it matches (the Timer, Stats).

import { Window as KitWindow, WindowBar, WindowBarMenu, WindowBody, WindowFrame } from "@cmd/ui";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { TreeNode, WidgetOut, WireValue } from "@cmd/protocol";
import { run } from "@cmd/widget-api/runtime";
import { createHost } from "@cmd/widget-api/testing/host";
import { agent } from "@cmd/widget-api/testing/fixtures";
import AgentActivity from "@cmd/widget-api/examples/v1/agents.tsx";
import Countdown from "@cmd/widget-api/examples/v1/countdown.tsx";
import Usage from "@cmd/widget-api/examples/v1/usage.tsx";
import type { HostData } from "@cmd/widget-api/testing/host";
import type { StatInfo, StatResult } from "@cmd/protocol";
import { RefWindow } from "../../reference/RefWindow.tsx";
import { Timer } from "../timer/TimerView.tsx";
import { StatDetail, Stats } from "../stats/Stats.tsx";
import { SIZES, type SizeName } from "../../reference/RefWindow.tsx";
import { useWindowStatus } from "../../lib/windowActions.ts";
import { showContextMenu } from "../../lib/context.ts";
import { useWindowChrome } from "../registry.ts";
import { chromeOf, menuEntries, menuLabel } from "./chrome.ts";
import { PackageWidget } from "./PackageView.tsx";
import type { Frames } from "./FrameElement.tsx";
import { cmd } from "../../lib/bridge.ts";
import chartPage from "./frame-chart.html?raw";
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
const quiet: WidgetLink = { interact: () => {}, resync: () => {}, restart: () => {}, ask: () => {}, env: () => {} };

/** A widget's window at a reference size, with the title bar its Window fills. */
function Widget({ messages, size = "regular", name = "Example", link = quiet, store: given, frames }: { messages?: TreeMessage[]; size?: SizeName | readonly [number, number]; name?: string; link?: WidgetLink; store?: TreeStore; frames?: Frames }) {
  const id = useMemo(() => `story-widget-${++windows}`, []);
  const store = useMemo(() => {
    if (given) return given;
    const s = new TreeStore({ resync: () => {} });
    for (const m of messages ?? []) s.apply(m);
    return s;
  }, [given, messages]);
  const [width, height] = typeof size === "string" ? SIZES[size] : size;
  return (
    <KitWindow selected style={{ width, height, position: "relative", flex: "none" }}>
      <WindowBody style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <Bar id={id} name={name} />
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <PackageWidget windowId={id} store={store} link={link} frames={frames ? () => frames : null} />
        </div>
      </WindowBody>
      <WindowFrame />
    </KitWindow>
  );
}

function Bar({ id, name }: { id: string; name: string }) {
  useWindowChrome();
  const status = useWindowStatus(id);
  const c = chromeOf(id);
  return (
    <WindowBar icon="puzzlepiece.extension" name={name}>
      <span className="ui-window-bar-meta">{status?.label}</span>
      {c?.menu?.length ? <WindowBarMenu onClick={() => void showContextMenu(menuEntries(c.menu, c.send))}>{c.menuLabel ?? menuLabel(c.menu)}</WindowBarMenu> : null}
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
  <div style={{ display: "flex", gap: 16 }}>
    <W
      nodes={tree(
        e("Window", { status: "2 waiting for you · 1 working", menu: [{ label: "This Workspace", checked: true, run: h() }, { label: "All Workspaces", checked: false, run: h() }], actions: [{ label: "Refresh", run: h() }] }, e("View", { inset: true }, e("Text", {}, "The title bar says what this Window's status and menu are."))),
      )}
    />
    <W nodes={tree(e("Window", { menuLabel: "3 hidden", menu: [{ label: "Agents", checked: true, run: h() }, { label: "Commands", checked: false, run: h() }] }, e("View", { inset: true }, e("Text", {}, "The title menu's button says its menuLabel (1.3)."))))} />
  </div>
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
/** A filter field with its count; Return sends `onSubmit` (1.3: run the first match). */
export const ToolbarSearchField = () => <W nodes={toolbar(e("ToolbarSearchField", { value: "to", placeholder: "Filter agents", count: "1 of 2", onChange: h(), onSubmit: h() }))} />;
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
/** Rows: selected, dim, under another, with a context menu; the selected one `reveal`s itself (1.3: scrolled into view when it becomes true). */
export const ListRow = () => <W nodes={tree(e("View", {}, e("List", {}, e("ListRow", { selected: true, reveal: true, onClick: h() }, e("ListRowContent", { title: "Selected" })), e("ListRow", { dim: true, onClick: h() }, e("ListRowContent", { title: "Dim" })), e("ListRow", { depth: 1, tip: "Under the row above", onClick: h() }, e("ListRowContent", { title: "Nested" })))))} />;
/** An icon, or a status light in its place. */
export const ListRowIcon = () => <W nodes={tree(e("View", {}, e("List", {}, ...(["needs", "working", "done", "idle", "off", "danger"] as const).map((l) => e("ListRow", {}, e("ListRowIcon", { icon: "sparkle", light: l }), e("ListRowContent", { title: l }))))))} />;
/** A title with a place, or with a detail line. */
export const ListRowContent = () => <W nodes={tree(e("View", {}, e("List", {}, row("One line", { place: "cmd-perf" }), row("Two lines", { detail: "Editing packages/core/src/agents/tracker.ts" }), row("packages/ui/src/list.tsx", { mono: true }))))} />;
/** What sits at a row's end. */
export const ListRowEnd = () => <W nodes={tree(e("View", {}, e("List", {}, row("Chip", {}, e("Chip", {}, "4m")), row("Badge", {}, e("Badge", { size: "sm", tone: "danger" }, "failed")))))} />;
/** Small pills of text, neutral or in a hue. */
export const Chip = () => <W nodes={inView(e("Inline", {}, e("Chip", {}, "now"), e("Chip", { hue: 140, tip: "Branch" }, "main"), e("Chip", { hue: 20 }, "release")))} />;

/** Numbers with their labels, a change, one pressable; (1.3) the change as a Delta by `trend` and `good`, a Sparkline inside the tile in its series' colour (Resources' CPU and memory). */
export const Stat = () => (
  <W
    size="wide"
    nodes={inView(
      e("Inline", { gap: 6 }, e("Stat", { label: "Waiting", value: 2, onSelect: h() }), e("Stat", { label: "p95", value: 412, unit: "ms", delta: "+12%", deltaTone: "danger" })),
      e(
        "Tiles",
        { min: 120, gap: 4 },
        e("Stat", { label: "CPU", value: "38%", delta: "12%", trend: "up", good: "down" }, e("Sparkline", { values: [12, 18, 15, 30, 26, 38, 33, 41, 38], series: 0 })),
        e("Stat", { label: "Memory", value: "1.2 GB", delta: "4%", trend: "down", good: "down" }, e("Sparkline", { values: [900, 950, 1000, 1100, 1150, 1200, 1180, 1210, 1200], series: 1 })),
        e("Stat", { label: "Turns", value: 412, delta: "±0%", trend: "flat", good: "up" }, e("Sparkline", { values: [40, 60, 52, 70, 64, 58, 68], color: "neutral" })),
      ),
    )}
  />
);
/** Recent values as a line; (1.3) in the chart palette's nth colour by `series`. */
export const Sparkline = () => <W nodes={inView(e("Sparkline", { values: [3, 5, 4, 8, 6, null, 7, 9, 12, 10], height: 32 }), e("Sparkline", { values: [1, 2, 1, 3, 2, 4], color: "neutral", area: false }), ...[1, 2, 3, 4, 5].map((series) => e("Sparkline", { values: [3, 5, 4, 8, 6, 7, 9, 12, 10].map((v) => v + series), series })))} />;
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
const DIALS: Record<string, WireValue>[] = [
  { value: "17:42", progress: 0.71, caption: "ends 14:32", editable: true, onSubmit: h() },
  { value: "9:05", progress: 0.36, tone: "dim", caption: "paused" },
  { value: "0:00", progress: 1, tone: "needs", caption: "done at 14:32" },
];
/** A value across the room in a ring (1.3): running, paused (dim), done (needs); the first editable: click it, type, Return. */
export const Dial = () => (
  <div style={{ display: "flex", gap: 16 }}>
    {DIALS.map((p, i) => (
      <W key={i} size="narrow" nodes={tree(e("View", {}, e("Dial", { label: "Time", ...p })))} />
    ))}
  </div>
);

export const Progress = () => <W nodes={inView(e("Progress", { value: 0.4, label: "Deploying" }), e("Progress", { tone: "success", value: 1 }), e("Progress", { label: "Waiting" }))} />;

// ── API 1.2: the window-content kit ────────────────────

const week = Array.from({ length: 7 }, (_, i) => Date.UTC(2026, 9, 9 + i));
const weekLabels = ["F", "S", "S", "M", "T", "W", "T"];
const runs = (values: (number | null)[], key = "runs", label = "Runs") => ({ key, label, values });

/** A dashboard's sections, two side by side once the window is wide. */
export const Panes = () => <W size="wide" nodes={tree(e("View", { inset: true }, e("Panes", {}, e("Pane", { title: "Agents", aside: 3 }, e("Text", {}, "Three working.")), e("Pane", { title: "Commands", aside: "today" }, e("Text", {}, "12 run, 1 failed.")))))} />;
/** A section: a title with an aside, and one that spans every column. */
export const Pane = () => <W size="wide" nodes={tree(e("View", { inset: true }, e("Panes", {}, e("Pane", { wide: true, title: "This week", aside: "runs" }, e("Sparkline", { values: [3, 5, 4, 8, 6, 7, 9], height: 32 })), e("Pane", { title: "Busiest" }, e("Text", { tone: "dim" }, "pnpm test")))))} />;
/** A list framed edge to edge: a toolbar over a scrolling body. */
export const Panel = () => <W nodes={tree(e("Panel", {}, e("WindowToolbar", { label: "Filter" }, e("ToolbarSearchField", { value: "", placeholder: "Filter events", onChange: h() })), e("PanelBody", {}, row("command", { detail: "pnpm test · exit 1" }), row("agent.stop", { detail: "Tours" }))))} />;
/** A Panel's body: the rows scroll under the toolbar. */
export const PanelBody = () => <W nodes={tree(e("Panel", {}, e("PanelBody", {}, ...["git.commit", "command", "agent.prompt", "notification"].map((t) => row(t, { light: "idle" })))))} />;
/** The main action on its own, above the sections. */
export const ListGroup = () => <W nodes={tree(e("View", {}, e("List", {}, e("ListGroup", {}, row("dev", { detail: "Starts the dev server", light: "idle" })), e("ListSection", { title: "Test", count: 1 }, row("test", { light: "idle" })))))} />;
const actionRow = (title: string, running: boolean) =>
  e("ListRow", { onClick: h() }, e("ListRowIcon", { icon: "play", light: running ? "working" : "idle" }), e("ListRowContent", { title, mono: true, detail: running ? "Running · 4m" : "vite" }), e("ListRowEnd", {}, e("ListValue", {}, running ? "4m" : "12s")), e("ListRowActions", {}, running ? e("IconButton", { icon: "stop.fill", label: "Stop", size: "sm", onClick: h() }) : e("IconButton", { icon: "play.fill", label: "Run", size: "sm", onClick: h() })));
/** Buttons a row shows on hover, in place of its end: hover a row. */
export const ListRowActions = () => <W nodes={tree(e("View", {}, e("List", {}, e("ListSection", { title: "Dev", count: 2 }, actionRow("dev", true), actionRow("preview", false)))))} />;
/** Numbers at a row's end, in even-width digits; one strong. */
export const ListValue = () => <W nodes={tree(e("View", {}, e("List", {}, row("zsh", { light: "idle" }, e("ListValue", {}, "0.4%")), row("node", { light: "working" }, e("ListValue", { strong: true }, "38%")))))} />;
/** Output and an error, monospaced, scrolling past a height. */
export const CodeBlock = () => <W nodes={inView(e("CodeBlock", {}, '{\n  "type": "command",\n  "command": "pnpm test",\n  "exitCode": 1\n}'), e("CodeBlock", { tone: "danger", maxHeight: 60 }, "Error: expected 2 to be 3\n    at add.test.ts:4:12"))} />;
/** Symbols on their own, at the sizes the kit uses. */
export const Icon = () => <W nodes={inView(e("Inline", { gap: 3 }, ...([12, 13, 14, 20, 22] as const).map((size) => e("Icon", { name: "bolt", size })), e("Icon", { name: "checkmark.seal", weight: "semibold" })))} />;
/** An icon, or a status light in its place. */
export const Mark = () => <W nodes={inView(e("Inline", { gap: 3 }, e("Mark", { icon: "terminal" }), e("Mark", { icon: "terminal", light: "working" }), e("Mark", { icon: "macwindow", tone: "dim" }), e("Mark", { icon: "sparkle", light: "needs" })))} />;
/** Changes: better, worse, flat, neutral. */
export const Delta = () => <W nodes={inView(e("Inline", { gap: 3 }, e("Delta", { text: "18%", trend: "up", good: "up" }), e("Delta", { text: "4%", trend: "up", good: "down" }), e("Delta", { text: "±0%", trend: "flat", good: "up" }), e("Delta", { text: "12%", trend: "down" })))} />;
/** Something happening, in a line. */
export const Spinner = () => <W nodes={inView(e("Inline", { gap: 2 }, e("Spinner", { label: "Describing" }), e("Text", { tone: "dim" }, "Describing actions…")), e("Inline", { gap: 2 }, e("Spinner", { size: 16 }), e("Text", {}, "Larger")))} />;
/** The view's footer: counts, and a quiet link at its end. */
export const StatusLine = () => <W nodes={tree(e("View", {}, e("List", {}, row("dev", { light: "working" }), row("test", { light: "idle" })), e("StatusLine", { action: { label: "Show All", run: h() } }, "12 actions · 1 running")))} />;
/** Icon buttons: ghost, filled, pressed, toned, pulsing, disabled. */
export const IconButton = () => <W nodes={inView(e("Inline", { gap: 2 }, e("IconButton", { icon: "arrow.clockwise", label: "Refresh", onClick: h() }), e("IconButton", { icon: "play.fill", label: "Run", variant: "default", onClick: h() }), e("IconButton", { icon: "pin", label: "Pin", pressed: true, onClick: h() }), e("IconButton", { icon: "bell", label: "Waiting", tone: "needs", pulse: true, onClick: h() }), e("IconButton", { icon: "stop.fill", label: "Stop", size: "sm", disabled: true })))} />;
/** Links in running text and in a dim line. */
export const LinkButton = () => <W nodes={inView(e("Inline", { gap: 1 }, e("LinkButton", { onClick: h() }, "Set up AI"), e("Text", { tone: "dim" }, "to see what each action does.")), e("Inline", { gap: 3 }, e("LinkButton", { tone: "dim", onClick: h() }, "in main"), e("LinkButton", { tone: "danger", onClick: h() }, "Remove")))} />;
/** Fields in the body: plain, code, with an icon, invalid, disabled. */
export const TextField = () => <W nodes={inView(e("TextField", { value: "25 min", placeholder: "Length: 10, 1:30, 90s", onChange: h(), onSubmit: h() }), e("TextField", { value: "pnpm test", code: true, icon: "terminal", fill: true, onChange: h() }), e("TextField", { value: "soon", invalid: true, label: "When" }), e("TextField", { value: "", placeholder: "Off", disabled: true }))} />;

/** Lines over a week: one filled, the week before dashed. */
export const TimeSeries = () => <W nodes={inView(e("TimeSeries", { buckets: week, series: [runs([12, 9, 4, 18, 22, 15, 19].map((x) => x * 20_000_000), "mem", "Memory")], previous: [10, 11, 6, 14, 18, 16, 12].map((x) => x * 20_000_000), labels: weekLabels, current: 6, unit: "bytes", label: "Memory", summary: "Memory · 280 MB on average", onSelect: h() }), e("TimeSeries", { buckets: week, series: [runs([1, 2, 1, 3, 2, 4, 3], "a", "Claude"), runs([0, 1, 2, 1, 1, 2, 2], "b", "Codex")], labels: weekLabels, label: "Agents at once", height: 80 }))} />;
/** Bars over a week: today in the accent, the average, two series stacked; the first as a stat's detail (1.3): the value bold, its change as a Delta and a note. */
export const TimeBars = () => <W nodes={inView(e("TimeBars", { buckets: week, series: [runs([3_600_000, 1_800_000, 0, 7_200_000, 9_000_000, 5_400_000, 6_300_000], "time", "Agent time")], previous: [3_000_000, 2_400_000, 600_000, 6_000_000, 8_000_000, 6_000_000, 4_000_000], labels: weekLabels, current: 6, unit: "ms", label: "Agent time", summary: "9h 15m", delta: { text: "+11%", trend: "up", good: "up" }, note: "median 1h 30m, 90% under 2h 30m", average: true, onSelect: h() }), e("TimeBars", { buckets: week, series: [runs([12, 9, 0, 18, 22, 15, 19], "ok", "Passed"), runs([1, 0, 0, 3, 2, 1, 4], "bad", "Failed")], labels: weekLabels, label: "Test runs", height: 80 }))} />;
/** A track's position: playing, and one at its start. */
export const TimeBar = () => <W nodes={inView(e("TimeBar", { duration: 214, time: 81, playing: false, onSeek: h() }), e("TimeBar", { duration: 3600, time: 0, label: "Episode" }))} />;
/** The top few, with notes; pressable rows. */
export const Ranking = () => <W nodes={inView(e("Ranking", { rows: [{ key: "test", label: "pnpm test", value: 41, note: "9% failed" }, { key: "dev", label: "pnpm dev", value: 23 }, { key: "e2e", label: "pnpm e2e", value: 8, note: "25% failed" }], onSelect: h() }), e("Ranking", { rows: [], empty: "No commands this week" }))} />;
/** Shares of a whole. */
export const Proportion = () => <W nodes={inView(e("Proportion", { parts: [{ key: "claude", label: "Claude", value: 5_400_000 }, { key: "codex", label: "Codex", value: 2_100_000 }, { key: "you", label: "You", value: 900_000 }], unit: "ms" }))} />;
/** When things happen: weekdays × hours. */
export const PunchCard = () => <W size="wide" nodes={inView(e("PunchCard", { values: Array.from({ length: 7 }, (_, r) => Array.from({ length: 24 }, (_, hr) => (hr > 8 && hr < 19 && r < 5 ? ((r * 7 + hr * 3) % 11) + 1 : hr === 22 ? 2 : 0))), rows: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], unit: "count", label: "Commands by hour" }))} />;
/** A run of days, empty days still there. */
export const Calendar = () => <W size="wide" nodes={inView(e("Calendar", { start: Date.UTC(2026, 6, 1), values: Array.from({ length: 105 }, (_, i) => (i % 7 > 4 ? 0 : i % 13 === 0 ? null : ((i * 37) % 9) * 600_000)), unit: "ms", label: "Agent time per day", onSelect: h() }))} />;
const entry = (time: string, hue: number, what: string, picked = false) => e("TimelineEntry", { time, hue, label: what, picked, reveal: picked }, e("Text", {}, what));
/** Entries down a rail. */
export const Timeline = () => <W nodes={inView(e("Timeline", {}, entry("09:12", 210, "Started on the widget API's 1.2 elements"), entry("10:40", 140, "Tests pass; Event Stream ported", true), entry("12:05", 20, "The e2e run found a stale tree")))} />;
/** One entry: its time, a mark in its hue, what happened; the picked one `reveal`s itself (1.3), as a ribbon's pick scrolls to it. */
export const TimelineEntry = () => <W nodes={inView(e("Timeline", {}, entry("14:05", 280, "Merged builtin-wave1", true), entry("14:20", 50, "Released 0.31")))} />;
const hour = 3_600_000;
const t0 = Date.UTC(2026, 9, 15, 8);
/** A day's work on lanes, one bar picked. */
export const Ribbon = () => <W nodes={inView(e("Ribbon", { items: [{ id: "a", start: t0 + hour, end: t0 + 3.5 * hour, hue: 210, label: "Elements" }, { id: "b", start: t0 + 2 * hour, end: t0 + 4 * hour, hue: 140, label: "Event Stream" }, { id: "c", start: t0 + 5 * hour, end: t0 + 7.5 * hour, hue: 20, label: "Run Scripts" }], from: t0, to: t0 + 9 * hour, ticks: [0, 3, 6, 9].map((i) => ({ at: t0 + i * hour, label: `${String(8 + i).padStart(2, "0")}:00` })), picked: "b", onPick: h() }))} />;

const procColumns: Record<string, WireValue>[] = [
  { key: "mark", label: "", icon: true },
  { key: "name", label: "Terminal", grow: true },
  { key: "top", label: "Busiest", hide: "regular", dim: true },
  { key: "cpu", label: "CPU", align: "end" },
  { key: "memory", label: "Memory", align: "end" },
];
const procRows: Record<string, WireValue>[] = [
  { key: "t1", cells: ["terminal", "pnpm dev · cmd", "node, esbuild", "38%", "412 MB"], light: "working", tip: "pnpm dev\nnode, esbuild" },
  { key: "t2", cells: ["terminal", "claude · cmd-perf", "claude", "4%", "220 MB"] },
  { key: "t3", cells: ["terminal", "zsh", null, "0%", "8 MB"] },
];
/** A table: an icon column, a dim column that drops when narrow, numbers at the end, sorted by CPU, one row selected. */
export const DataGrid = () => (
  <div style={{ display: "flex", gap: 16 }}>
    <W nodes={tree(e("View", {}, e("DataGrid", { columns: procColumns, rows: procRows, sort: { key: "cpu", desc: true }, selected: "t2", onSort: h(), onRowClick: h(), onRowDoubleClick: h() })))} />
    <W size="narrow" nodes={tree(e("View", {}, e("DataGrid", { columns: procColumns, rows: [{ key: "h", cells: ["", "cmd", null, "42%", "640 MB"], heading: true }, { ...procRows[0]!, depth: 1, expanded: true }, { ...procRows[1]!, depth: 2 }], onToggle: h() })))} />
  </div>
);

// ── the example widget, and the window's states ────────

/** A widget of the package's examples running in the widget runtime against the fake host: its tree is what the view draws. */
function Running({ widget, data, name, size, id }: { widget: () => ReactNode; data: HostData; name: string; size?: SizeName; id: string }) {
  const [store] = useState(() => new TreeStore({ resync: () => {} }));
  const [link, setLink] = useState<WidgetLink | null>(null);
  useEffect(() => {
    const host = createHost(data);
    const transport = {
      send: (m: WidgetOut) => {
        if (m.kind === "tree" || m.kind === "patch") store.apply(m);
        host.transport.send(m);
      },
      listen: host.transport.listen,
    };
    const running = run(transport, widget, {
      package: id,
      version: "1.0.0",
      widget: id,
    });
    setLink({
      interact: (handler, event, value) =>
        host.deliver({
          kind: "interaction",
          handler,
          event,
          ...(value === undefined ? {} : { value }),
        }),
      resync: () => host.deliver({ kind: "resync" }),
      restart: () => {},
      ask: () => {},
      env: () => {},
    });
    return () => void running.then((r) => r.stop());
  }, [store]); // eslint-disable-line react-hooks/exhaustive-deps
  return link ? <Widget store={store} link={link} name={name} size={size} /> : null;
}

/** packages/widget-api/examples/v1/agents.tsx: Agent Activity. */
export const ExampleAgents = () => (
  <Running
    id="agents"
    name="Agent Activity"
    widget={AgentActivity}
    data={{
      agents: [
        agent({
          name: "Tours",
          state: "waiting",
          statusLine: "Wants to run pnpm e2e",
          place: "cmd-tours",
        }),
        agent({
          name: "Perf",
          state: "working",
          statusLine: "Running the stress test",
          place: "cmd-perf",
        }),
        agent({
          name: "Explore",
          state: "working",
          depth: 1,
          parentId: "a-perf",
        }),
        agent({
          name: "Docs",
          state: "done",
          statusLine: "Wrote the API reference",
          place: "cmd",
        }),
      ],
    }}
  />
);

// ── 1.3's display pieces, beside the native views ───────

/** A countdown's states: set (25 min), paused at 17:42, done. */
const COUNTDOWN = {
  set: {},
  paused: { paused: 17 * 60 + 42 },
  done: { endsAt: 1 },
} as const;

/** The native Timer and countdown.tsx side by side in one state (one widget per variant: the runtime's `cmd` is one per page). */
function CountdownPair({ k }: { k: keyof typeof COUNTDOWN }) {
  return (
    <div style={{ display: "flex", gap: 16 }}>
      <RefWindow icon="timer" name="Timer" size="regular">
        <Timer phase={k === "set" ? "idle" : k} duration={25 * 60} remaining={k === "paused" ? 17 * 60 + 42 : k === "done" ? 0 : 25 * 60} caption={k === "paused" ? "paused" : k === "done" ? `done at ${new Date(1).toTimeString().slice(0, 5)}` : undefined} onAction={() => {}} onDuration={() => {}} />
      </RefWindow>
      <Running id="countdown" name="Countdown" widget={Countdown} data={{ state: COUNTDOWN[k] }} />
    </div>
  );
}
/** packages/widget-api/examples/v1/countdown.tsx (Dial, menuLabel) beside the native Timer, set: click the time to type a length. */
export const CountdownSet = () => <CountdownPair k="set" />;
/** Paused: the ring dim. */
export const CountdownPaused = () => <CountdownPair k="paused" />;
/** Done: the ring full, in the needs tone. */
export const CountdownDone = () => <CountdownPair k="done" />;

const DAY = 86_400_000;
const TODAY = new Date(2026, 9, 14).getTime();
/** A week of a stat ending today, and the week before's total. */
function statWeek(id: string, title: string, unit: StatInfo["unit"], values: number[], before: number, good?: "up" | "down"): StatResult {
  const buckets = values.map((_, i) => TODAY - (values.length - 1 - i) * DAY);
  const total = values.reduce((a, b) => a + b, 0);
  const stat: StatInfo = {
    id,
    title,
    description: `${title}, made up for the story.`,
    kind: "count",
    unit,
    dims: [],
    measure: "sum",
    class: "agents",
    available: true,
    ...(good ? { good } : {}),
  };
  return {
    stat,
    from: buckets[0]!,
    to: TODAY + DAY,
    grain: "day",
    measure: "sum",
    buckets,
    series: [{ key: "total", label: title, values, total }],
    total,
    previous: { total: before, values: values.map((v) => Math.round(v * 0.8)) },
    asOf: TODAY + 15 * 3_600_000,
  };
}
const H = 3_600_000;
const WEEK = {
  time: statWeek("agents.time", "Agent time", "ms", [3.2 * H, 5 * H, 1.5 * H, 6.5 * H, 8 * H, 4.2 * H, 5.1 * H], 30 * H, "up"),
  active: statWeek("you.active", "Active time", "ms", [2 * H, 3.5 * H, 1 * H, 4 * H, 5 * H, 3 * H, 2.5 * H], 24 * H, "up"),
  turns: statWeek("agents.turns", "Turns", "count", [40, 62, 18, 75, 90, 51, 66], 402),
  runs: statWeek("commands.runs", "Commands", "count", [120, 160, 40, 210, 260, 140, 180], 1110),
};

const USAGE_STATS = Object.fromEntries(Object.values(WEEK).map((r) => [r.stat.id, r]));
/** packages/widget-api/examples/v1/usage.tsx (Stat trend and children, fmt.value and fmt.delta) beside the native Stats window's tiles. */
export const UsageBesideStats = () => (
  <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
    <RefWindow icon="chart.bar" name="Stats" size="wide">
      <Stats range="week" data={WEEK} onRange={() => {}} onOpen={() => {}} now={WEEK.time.asOf} />
    </RefWindow>
    <Running id="usage" name="Usage" size="wide" widget={Usage} data={{ stats: USAGE_STATS }} />
  </div>
);
/** usage.tsx with a stat open (a chart's delta and note, a row revealed) beside the native Stats window's detail. */
export const UsageDetailBesideStats = () => (
  <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
    <RefWindow icon="chart.bar" name="Stats" size="wide">
      <StatDetail result={WEEK.time} range="week" by={null} onBy={() => {}} onRange={() => {}} onBack={() => {}} now={WEEK.time.asOf} />
    </RefWindow>
    <Running id="usage" name="Usage" size="wide" widget={Usage} data={{ state: { open: "agents.time" }, stats: USAGE_STATS }} />
  </div>
);

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

/** A Frame's page in a story: inline (frame-chart.html), no widget API; null where the app can't serve one (tests). */
const storyFrames: Frames = {
  windowId: null,
  serve: async (_src, init) => (typeof cmd.packageFrame === "function" ? cmd.packageFrame({ html: chartPage, media: [], init }) : null),
  reloadKey: "story",
  active: true,
  kv: {},
  config: {},
};
const frameTree = (values: number[]) =>
  inView(
    e("Inline", { gap: 4 }, e("Stat", { label: "Runs today", value: values.reduce((a, b) => a + b, 0) }), e("Stat", { label: "Busiest hour", value: `${8 + values.indexOf(Math.max(...values))}:00` })),
    e("Frame", { src: "chart.html", label: "Runs per hour", height: 180, data: { values }, onMessage: h() }),
    e("Text", { tone: "dim", size: "sm" }, "Click a bar: the page posts its index to the widget."),
  );

/** A canvas chart in a kit window: a Frame between Stats, drawn from its data in the theme's colours; beside it, the same tree where pixels aren't drawn (a preview, the phone), its label standing in. */
export const Frame = () => (
  <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
    <Widget messages={frameTree([3, 5, 2, 8, 13, 9, 4, 6, 11, 7])} frames={storyFrames} name="Runs" />
    <Widget messages={frameTree([3, 5, 2, 8, 13, 9, 4, 6, 11, 7])} name="Runs" size="narrow" />
  </div>
);

// ── 1.3: layout by size ─────────────────────────────────

const controls = () => e("Inline", { gap: 2 }, e("IconButton", { icon: "backward.fill", label: "Previous", onClick: h() }), e("IconButton", { icon: "pause.fill", label: "Pause", size: "lg", onClick: h() }), e("IconButton", { icon: "forward.fill", label: "Next", onClick: h() }));
const track = (title: Record<string, WireValue>) => e("Stack", { gap: 0.5 }, e("Text", { strong: true, truncate: true, ...title }, "Windowlicker"), e("Text", { tone: "dim", truncate: true }, "Aphex Twin"));
/** A player's three faces: short (a line, the controls at the bottom), large (a centred column, its title fit to it) and the fallback. */
const faces = () =>
  tree(
    e(
      "View",
      { scroll: false },
      e(
        "Adapt",
        {},
        e("Case", { maxHeight: 280 }, e("Stack", { pad: "inset", gap: 3, grow: true, justify: "between" }, track({}), controls())),
        e("Case", { minWidth: 340, minHeight: 440 }, e("Stack", { pad: "inset", gap: 4, grow: true, align: "center", justify: "center" }, e("Text", { strong: true, fit: true, size: "lg" }, "Windowlicker"), e("Text", { tone: "dim" }, "Aphex Twin"), controls())),
        e("Case", {}, e("Stack", { pad: "inset", gap: 3, grow: true, justify: "end" }, track({ size: "xl" }), controls())),
      ),
    ),
  );

/** One tree at three window sizes, each its own face, picked here from the Adapt's measured box: short (420×240), the fallback (320×400), large (420×520). */
export const Adapt = () => (
  <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
    {([[420, 240], [320, 400], [420, 520]] as const).map((s) => (
      <Widget key={s.join("x")} messages={faces()} size={s} name="Player" />
    ))}
  </div>
);

/** A Case outside an Adapt is just its children; inside one, see Adapt. */
export const Case = () => <W nodes={inView(e("Case", { minWidth: 400 }, e("Text", {}, "A Case's layout.")))} />;
