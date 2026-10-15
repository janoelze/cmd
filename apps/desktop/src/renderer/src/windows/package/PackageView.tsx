// A widget package's window (docs/56, "The view: React, drawn by the app"): the tree its
// process sends, drawn with the kit through the element table (elements.tsx), presses
// and typing sent back as interactions. Around it: the process's state when there is no
// tree to show (starting, stopped with Restart, waiting for the person's permission, with
// Allow… to ask again; a widget with settings it needs and none set yet: "Set up" with
// Configure…); a stopped process with a tree drawn before keeps it, under a banner
// saying why (a save that didn't load: its error) with Restart;
// an error boundary so a tree that can't be drawn shows a Callout and not a broken
// board, and `widget.env` whenever the window's theme, size class or placement changes.
// A frame widget (`"surface": "frame"`) draws its page instead of a tree (PackageFrame.tsx); a
// tree's Frame elements draw pages of the package in it (FrameElement.tsx, FramesContext).

import { Button, Callout, Stack, View, type ViewStateSpec } from "@cmd/ui";
import { Component, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { TreeNode, WindowId } from "@cmd/protocol";
import { useStoreValue } from "../../lib/store.ts";
import { PlacementContext, windowChromeChanged, type WindowViewProps } from "../registry.ts";
import { configurable, configure, needsSetup } from "./ConfigSheet.tsx";
import { drawAll, type DrawContext } from "./elements.tsx";
import { closeTree, openTree, rpcLink, type WidgetLink, type WidgetPlace } from "./live.ts";
import { PackageFrame, configOf, servePage } from "./PackageFrame.tsx";
import { FramesContext, type Frames } from "./FrameElement.tsx";
import type { TreeSnapshot, TreeStore } from "./tree.ts";

export function PackageView({ win, focused }: WindowViewProps) {
  const name = typeof win.state.package === "string" ? win.state.package : "";
  const link = useMemo(() => rpcLink(win.id, name), [win.id, name]);
  const [store, setStore] = useState<TreeStore | null>(null);
  useEffect(() => {
    setStore(openTree(win.id, link));
    return () => closeTree(win.id);
  }, [win.id, link]);
  const entry = useStoreValue((s) => s.library.find((e) => e.kind === win.kind));
  // The title menu's Configure… follows the Library (register.tsx reads it when it draws).
  const canConfigure = configurable(entry);
  useEffect(() => windowChromeChanged(), [canConfigure]);
  const setup = needsSetup(entry, win.state.config as Record<string, unknown> | undefined) ? { title: entry!.title, configure: () => configure(win.id) } : null;
  const placement = useContext(PlacementContext);
  const grant = JSON.stringify(entry?.ask ?? null) + JSON.stringify(entry?.permissions ?? null);
  const kv = (win.state.kv as Record<string, unknown> | undefined) ?? {};
  const config = configOf(entry, win);
  // The tree's Frames (API 1.2): pages of the package with the window's widget API, loaded again with the grant or a restart.
  const frames = (reload: number): Frames => ({ windowId: win.id, serve: (src, init) => servePage(win.id, src, init), reloadKey: `${win.id}\n${grant}\n${reload}`, active: focused, kv, config, placement });
  if (!store) return <View state={STARTING} />;
  const frame = entry?.surface === "frame" ? (reload: number) => <PackageFrame win={win} entry={entry} active={focused} reload={reload} /> : null;
  return <PackageWidget windowId={win.id} store={store} link={link} setup={setup} frame={frame} frames={frames} />;
}

/** A widget that needs settings before it can show anything: its title and the way to the Configure sheet. */
export interface Setup {
  title: string;
  configure(): void;
}

const STARTING: ViewStateSpec = { kind: "loading", title: "Starting…" };

/**
 * A widget's tree and state, drawn; the view without the core (stories and tests give it a store and a link of their own).
 * A frame widget (`frame`) draws its page instead, from its first draw, the tree giving only the title bar; each restart of
 * its process (a save) loads the page again (`reload`).
 */
export function PackageWidget({ windowId, store, link, setup = null, frame = null, frames = null }: { windowId: WindowId; store: TreeStore; link: WidgetLink; setup?: Setup | null; frame?: ((reload: number) => ReactNode) | null; frames?: ((reload: number) => Frames) | null }) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const reload = useRestarts(snap.status);
  const live = frames?.(reload) ?? null;
  const ctx = useMemo<DrawContext>(() => ({ windowId, send: (h, e, v) => link.interact(h, e, v) }), [windowId, link]);
  const [probe, size] = useSizeClass();
  const theme = useAppearance();
  const placement = useContext(PlacementContext);
  useEffect(() => link.env({ theme, size, placement }), [link, theme, size, placement]);

  const cover = frame ? frameCover(snap, link, setup) : coverOf(snap, link, setup);
  if (frame && !cover)
    return (
      <View scroll={false}>
        {snap.status === "stopped" && <Stopped snap={snap} link={link} />}
        {drawAll(chromeOnly(snap.nodes), ctx)}
        {frame(reload)}
      </View>
    );
  return (
    <>
      <span ref={probe} hidden />
      {cover ? (
        <View state={cover} />
      ) : (
        <>
          {snap.status === "stopped" && <Stopped snap={snap} link={link} />}
          <TreeBoundary rev={snap.rev}>
            <FramesContext.Provider value={live}>
              <Tree nodes={snap.nodes} ctx={ctx} />
            </FramesContext.Provider>
          </TreeBoundary>
        </>
      )}
    </>
  );
}

/** What replaces the tree: the process's state (or the settings it needs), unless it is running or restarting with a tree to keep on screen. */
function coverOf(snap: TreeSnapshot, link: WidgetLink, setup: Setup | null): ViewStateSpec | null {
  if (snap.status === "waiting-grant")
    return { kind: "empty", icon: "lock", title: "Waiting for permission", text: "This widget runs once you allow what it asks for.", action: <Button onClick={() => link.ask()}>Allow…</Button> };
  if (setup) return { kind: "empty", icon: "gearshape", title: `Set up ${setup.title}`, text: "It needs a few settings first.", action: <Button onClick={() => setup.configure()}>Configure…</Button> };
  if (snap.status === "stopped" && !snap.loaded)
    return { kind: "error", title: stoppedTitle(snap), ...(snap.detail ? { text: snap.detail } : {}), action: <Button icon="arrow.clockwise" onClick={() => link.restart()}>Restart</Button> };
  if (!snap.loaded) return STARTING;
  return null;
}

const stoppedTitle = (snap: TreeSnapshot) => (snap.reason ? `Stopped · ${snap.reason}` : "Stopped");

/** A stopped process over what it drew: why, and Restart. */
function Stopped({ snap, link }: { snap: TreeSnapshot; link: WidgetLink }) {
  return (
    <Callout tone="danger" banner title={stoppedTitle(snap)} actions={<Button size="sm" icon="arrow.clockwise" onClick={() => link.restart()}>Restart</Button>}>
      {snap.detail}
    </Callout>
  );
}

/** A frame widget's page needs the grant and its settings, not its process: those are all that cover it. */
function frameCover(snap: TreeSnapshot, link: WidgetLink, setup: Setup | null): ViewStateSpec | null {
  const c = coverOf(snap, link, setup);
  return snap.status === "waiting-grant" || setup ? c : null;
}

/** A frame widget's tree: its Window alone (the title bar's status and menus); the page is the content. */
const chromeOnly = (nodes: readonly TreeNode[]): TreeNode[] => nodes.filter((n) => n.type === "Window").map((n) => ({ ...n, children: [] }));

/** How many times the process started again after running (a save, Restart): the frame's page reloads with it. */
function useRestarts(status: TreeSnapshot["status"]): number {
  const [n, setN] = useState(0);
  const ran = useRef(false);
  useEffect(() => {
    if (status !== "running") return;
    if (ran.current) setN((x) => x + 1);
    ran.current = true;
  }, [status]);
  return n;
}

/** The top of the tree: a widget's own View (in its Window or not) draws the frame; anything else gets one. */
function Tree({ nodes, ctx }: { nodes: readonly TreeNode[]; ctx: DrawContext }) {
  const shown = nodes.filter((n) => n.type !== "#text" && !n.props.$hidden);
  const framed = shown.some((n) => n.type === "View" || (n.type === "Window" && n.children.some((c) => c.type === "View")));
  return framed ? <>{drawAll(nodes, ctx)}</> : <View>{drawAll(nodes, ctx)}</View>;
}

/** A tree that throws while drawing shows why, in the window; the next tree tries again. */
class TreeBoundary extends Component<{ rev: number; children: ReactNode }, { error: Error | null; rev: number }> {
  override state = { error: null as Error | null, rev: this.props.rev };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  static getDerivedStateFromProps(props: { rev: number }, state: { error: Error | null; rev: number }) {
    return props.rev !== state.rev ? { error: null, rev: props.rev } : null;
  }
  override componentDidCatch(error: unknown): void {
    console.warn(`widget: its tree couldn't be drawn: ${error instanceof Error ? error.message : String(error)}`);
  }
  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <View>
        <Stack pad="inset">
          <Callout tone="danger" title="This widget couldn't be drawn">
            {this.state.error.message}
          </Callout>
        </Stack>
      </View>
    );
  }
}

/** The window's size class, as the kit's breakpoints have it (narrow < 360px, regular < 600px, wide): measured on the window's content. */
function useSizeClass(): [(el: HTMLElement | null) => void, WidgetPlace["size"]] {
  const [size, setSize] = useState<WidgetPlace["size"]>("regular");
  const observer = useRef<ResizeObserver | null>(null);
  const probe = (el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    const box = el?.parentElement;
    if (!box || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const w = box.clientWidth;
      if (w > 0) setSize(w < 360 ? "narrow" : w < 600 ? "regular" : "wide");
    };
    observer.current = new ResizeObserver(measure);
    observer.current.observe(box);
    measure();
  };
  return [probe, size];
}

/** The app's appearance (applyTheme sets it on the root). */
function useAppearance(): WidgetPlace["theme"] {
  return useSyncExternalStore(subscribeAppearance, appearance);
}
const appearance = (): WidgetPlace["theme"] => (document.documentElement.dataset.appearance === "light" ? "light" : "dark");
function subscribeAppearance(fn: () => void): () => void {
  const o = new MutationObserver(fn);
  o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance"] });
  return () => o.disconnect();
}
