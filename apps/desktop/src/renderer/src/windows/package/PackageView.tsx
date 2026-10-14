// A widget package's window (docs/56, "The view: React, drawn by the app"): the tree its
// process sends, drawn with the kit through the element table (elements.tsx), presses
// and typing sent back as interactions. Around it: the process's state when there is no
// tree to show (starting, stopped with Restart, waiting for the person's permission),
// an error boundary so a tree that can't be drawn shows a Callout and not a broken
// board, and `widget.env` whenever the window's theme, size class or placement changes.

import { Button, Callout, Stack, View, type ViewStateSpec } from "@cmd/ui";
import { Component, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { TreeNode, WindowId } from "@cmd/protocol";
import { PlacementContext, type WindowViewProps } from "../registry.ts";
import { drawAll, type DrawContext } from "./elements.tsx";
import { closeTree, openTree, rpcLink, type WidgetLink, type WidgetPlace } from "./live.ts";
import type { TreeSnapshot, TreeStore } from "./tree.ts";

export function PackageView({ win }: WindowViewProps) {
  const link = useMemo(() => rpcLink(win.id), [win.id]);
  const [store, setStore] = useState<TreeStore | null>(null);
  useEffect(() => {
    setStore(openTree(win.id, link));
    return () => closeTree(win.id);
  }, [win.id, link]);
  if (!store) return <View state={STARTING} />;
  return <PackageWidget windowId={win.id} store={store} link={link} />;
}

const STARTING: ViewStateSpec = { kind: "loading", title: "Starting…" };

/** A widget's tree and state, drawn; the view without the core (stories and tests give it a store and a link of their own). */
export function PackageWidget({ windowId, store, link }: { windowId: WindowId; store: TreeStore; link: WidgetLink }) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const ctx = useMemo<DrawContext>(() => ({ windowId, send: (h, e, v) => link.interact(h, e, v) }), [windowId, link]);
  const [probe, size] = useSizeClass();
  const theme = useAppearance();
  const placement = useContext(PlacementContext);
  useEffect(() => link.env({ theme, size, placement }), [link, theme, size, placement]);

  const cover = coverOf(snap, link);
  return (
    <>
      <span ref={probe} hidden />
      {cover ? (
        <View state={cover} />
      ) : (
        <TreeBoundary rev={snap.rev}>
          <Tree nodes={snap.nodes} ctx={ctx} />
        </TreeBoundary>
      )}
    </>
  );
}

/** What replaces the tree: the process's state, unless it is running or restarting with a tree to keep on screen. */
function coverOf(snap: TreeSnapshot, link: WidgetLink): ViewStateSpec | null {
  if (snap.status === "waiting-grant") return { kind: "empty", icon: "lock", title: "Waiting for permission", text: "This widget runs once you allow what it asks for." };
  if (snap.status === "stopped")
    return { kind: "error", title: snap.reason ? `Stopped · ${snap.reason}` : "Stopped", action: <Button icon="arrow.clockwise" onClick={() => link.restart()}>Restart</Button> };
  if (!snap.loaded) return STARTING;
  return null;
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
