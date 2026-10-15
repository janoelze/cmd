// The trees of the package widgets on screen (docs/56): one TreeStore per window while
// its view is mounted, fed by the core's `widget.tree` events, and the link back to the
// widget's process over the core's widget.* methods.

import type { ApiBox, CoreEvent, WindowId, WireValue } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import { TreeStore } from "./tree.ts";

/** Where a widget's window is drawn, as `cmd.env` tells the process. */
export interface WidgetPlace {
  theme: "dark" | "light";
  size: "narrow" | "regular" | "wide";
  /** 1.3: the window content's box in px, rounded and throttled (PackageView's useContentBox); null until measured. */
  box: ApiBox | null;
  placement: "board" | "sidebar";
}

/** The way back to a widget's process: the core (rpcLink), or a fake in stories and tests. */
export interface WidgetLink {
  interact(handler: number, event: string, value?: WireValue): void;
  resync(): void;
  /** Start a stopped process again (Restart). */
  restart(): void;
  /** Ask the person again for what the widget's package wants (Allow… while it waits). */
  ask(): void;
  env(place: WidgetPlace): void;
}

const quiet = (p: Promise<unknown>) => void p.catch((err) => console.warn(`widget: ${err instanceof Error ? err.message : String(err)}`));

/** A window's link through the core; `name` is its package's. */
export function rpcLink(windowId: WindowId, name: string): WidgetLink {
  return {
    interact: (handler, event, value) => quiet(cmd.call("widget.interact", { windowId, handler, event, ...(value === undefined ? {} : { value }) })),
    resync: () => quiet(cmd.call("widget.resync", { windowId })),
    restart: () => quiet(cmd.call("widget.restart", { windowId })),
    ask: () => quiet(cmd.call("widget.ask", { name })),
    env: (place) => quiet(cmd.call("widget.env", { windowId, ...place })),
  };
}

const stores = new Map<WindowId, { store: TreeStore; views: number }>();

/** The window's tree while a view shows it; the first view asks for the whole tree (it may have been sent before). */
export function openTree(windowId: WindowId, link: WidgetLink): TreeStore {
  let s = stores.get(windowId);
  if (!s) {
    s = { store: new TreeStore({ resync: () => link.resync() }), views: 0 };
    stores.set(windowId, s);
    s.store.resync();
  }
  s.views++;
  return s.store;
}

export function closeTree(windowId: WindowId): void {
  const s = stores.get(windowId);
  if (s && --s.views <= 0) stores.delete(windowId);
}

/** A `widget.tree` event: to the window's store, if a view shows it (else the next one asks again). */
export function handleWidgetTree(e: Extract<CoreEvent, { type: "widget.tree" }>): void {
  stores.get(e.windowId)?.store.apply(e.message);
}

// Not in the store: a tree is this view's alone (as lib/acting.ts hears tool.acting).
cmd.onEvent((e) => e.type === "widget.tree" && handleWidgetTree(e));
