// A package widget's window and its process (docs/56-widgets-v3.md, "The runtime" and "The
// view"): what the core tells the window (its tree, then patches, and the process's status)
// and what the window tells the core (what the person did, where it is drawn). The process's
// own wire is widget-tree.ts; this is the app's side of it.

import type { WindowId } from "./model.ts";
import type { WidgetEnv, WidgetPatch, WidgetTree } from "./widget-tree.ts";
import type { WidgetPermissions } from "./widget-package.ts";
import type { Def } from "./settings.ts";

/**
 * A package widget's process as its window shows it: starting, running, stopped (with why:
 * "crashed", "stopped responding", "used too much memory", "made for a newer cmd"; Restart
 * starts it again) or waiting for the person to grant what it asks.
 */
export interface WidgetHostStatus {
  kind: "status";
  state: "starting" | "running" | "stopped" | "waiting-grant";
  reason?: string;
}

export interface WidgetHostMethods {
  /** The person acted on an element of a package widget's tree (`handler` from a HandlerRef, `event` the prop's name). */
  "widget.interact": { params: { windowId: WindowId; handler: number; event: string; value?: unknown }; result: null };
  /** Send this window's status and whole tree again as widget.tree events: a view opened late, or a rev skipped. */
  "widget.resync": { params: { windowId: WindowId }; result: null };
  /** Where a package widget's window is drawn (theme, size class, placement); the process gets it as `env`. */
  "widget.env": { params: { windowId: WindowId } & Pick<WidgetEnv, "theme" | "size" | "placement">; result: null };
  /** Start a stopped package widget's process again (Restart, after "Stopped · crashed"). */
  "widget.restart": { params: { windowId: WindowId }; result: null };
  /** Grant a package what it asks (`permissions` omitted: everything it declares); its waiting windows start. */
  "widget.grant": { params: { name: string; permissions?: WidgetPermissions }; result: { version: string; permissions: WidgetPermissions } };
}

/** A package widget's tree (whole, or a patch on the last rev) or its process's status, for its window. */
export type WidgetHostEvent = { type: "widget.tree"; windowId: WindowId; message: WidgetTree | WidgetPatch | WidgetHostStatus };

/** Widgets' settings, taken into SETTINGS_SCHEMA where they always stood (placed in the Settings window's Magic Widgets and Notifications pages). */
export const WIDGET_SETTINGS = {
  "widgets.developer": { title: "Developer widgets", type: "boolean", default: false, description: "Offer widgets that show what cmd records and does.", details: "Like the Event Stream. Safe to use; mostly useful when working on cmd or reporting a problem." },
  "notifications.widgets": { title: "Widgets report something", type: "boolean", default: true, description: "When a Magic widget reports news." },
  "widgets.aiBudget": { title: "AI budget per widget", type: "number", unit: "tokens a day", default: 200000, min: 0, step: 10000, description: "How much of your AI one widget may use a day. 0: no limit." },
} as const satisfies Record<string, Def>;
