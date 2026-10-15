// A package widget's window and its process (docs/56-widgets-v3.md, "The runtime" and "The
// view"): what the core tells the window (its tree, then patches, and the process's status)
// and what the window tells the core (what the person did, where it is drawn). The process's
// own wire is widget-tree.ts; this is the app's side of it.

import type { WindowId } from "./model.ts";
import type { ApiError, WidgetEnv, WidgetPatch, WidgetTree, WireValue } from "./widget-tree.ts";
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
  /** More about a stop, for the window to show: "didn't load" carries the widget's error (its message and first stack line). */
  detail?: string;
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
  /**
   * Ask the person for what a package wants now (the grants sheet: `cmd widget link`, Allow… in a
   * waiting window), or with `decline`, stop asking until asked again (the sheet's Decline).
   */
  "widget.ask": { params: { name: string; decline?: boolean }; result: null };
  "widget.grant": { params: { name: string; permissions?: WidgetPermissions }; result: { version: string; permissions: WidgetPermissions } };
  /**
   * Set a package widget window's config values (its `config` fields, not secrets): merged into
   * the window's, checked against the fields (an unknown key refused, a number or switch taken
   * from text, an enum one of its options); null or "" goes back to the default. The process
   * gets the new `config`.
   */
  "widget.config": { params: { windowId: WindowId; values: Record<string, unknown> }; result: null };
  /** Set (or with null, remove) a secret field of a package's widget, kept by cmd per package and widget; the value is never sent back. */
  "widget.secret": { params: { name: string; widget: string; key: string; value: string | null }; result: null };
  /** Which secret fields of a package's widget are set (their keys, never their values). */
  "widget.secrets": { params: { name: string; widget: string }; result: { set: string[] } };
  /**
   * What a frame widget's window draws (`"surface": "frame"`): its package folder (real path) and
   * the hosts its grant reaches, which its frame may load media and images from; null when the
   * window isn't a frame widget or its package waits for a grant.
   */
  "widget.frameSource": { params: { windowId: WindowId }; result: { dir: string; media: string[] } | null };
  /**
   * A frame's call (docs/56, "The frame surface"): any verb of the API (widget-verbs.ts), through
   * its window's API, with the grants, scope and limits of the widget's process. `frame`: which
   * frame of the window it is (the app's id for it, one per page it loads). `pressed`: the app's
   * gesture rule saw a press in that frame (AR1-11-05), set only for a verb that needs one
   * (needsPress); the core takes at most one a second per frame. A refusal is `ok: false` with
   * the error the process would get.
   */
  "widget.frame": { params: { windowId: WindowId; frame?: string; verb: string; params: unknown[]; pressed?: boolean }; result: WidgetFrameResult };
  /**
   * A frame's live topic (API_TOPIC: agents, terminals, events…), the same subscription as the
   * process's hooks: its value at once, then each change, as widget.frameEvent to this connection
   * only, until widget.frameUnsubscribe, the connection closes or the widget stops (an `end`).
   * `sub` is the app's id for it within the frame.
   */
  "widget.frameSubscribe": { params: { windowId: WindowId; frame: string; sub: number; topic: string; query?: unknown }; result: WidgetFrameResult };
  /** Stop a frame's subscription, or with no `sub` all of them (the frame is gone or loads again). */
  "widget.frameUnsubscribe": { params: { windowId: WindowId; frame: string; sub?: number }; result: null };
}

/** What a frame's call or subscription got: a value, or the refusal the widget's process would get. */
export type WidgetFrameResult = { ok: true; value: WireValue } | { ok: false; error: ApiError };

/** A package widget's console line or error, for `cmd widget dev`'s terminal (and nothing else: the app doesn't show them). */
export interface WidgetHostLog {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  /** An error's stack (a render error's, or one nothing caught). */
  stack?: string | null;
}

/** A package widget's tree (whole, or a patch on the last rev) or its process's status, for its window; its console, for whoever listens; a frame's subscription, for its connection. */
export type WidgetHostEvent =
  | { type: "widget.tree"; windowId: WindowId; message: WidgetTree | WidgetPatch | WidgetHostStatus }
  | ({ type: "widget.log"; windowId: WindowId } & WidgetHostLog)
  /** A frame's subscription (widget.frameSubscribe): its value now, or its `end` (the widget stopped, or its window closed). */
  | { type: "widget.frameEvent"; windowId: WindowId; frame: string; sub: number; data?: WireValue; end?: ApiError };

/** Widgets' settings, taken into SETTINGS_SCHEMA where they always stood (placed in the Settings window's Magic Widgets and Notifications pages). */
export const WIDGET_SETTINGS = {
  "widgets.developer": { title: "Developer widgets", type: "boolean", default: false, description: "Offer widgets that show what cmd records and does.", details: "Like the Event Stream. Safe to use; mostly useful when working on cmd or reporting a problem." },
  "notifications.widgets": { title: "Widgets report something", type: "boolean", default: true, description: "When a Magic widget reports news." },
  // A Magic build's token ceiling (magic/package/build.ts), placed with Magic's other build settings.
  "magic.maxTokens": { title: "Tokens per build", type: "number", unit: "tokens", default: 3000000, min: 0, step: 100000, description: "A build that uses more stops. 0: no limit.", details: "Counts what the model reads and writes, cached reads too." },
  "widgets.aiBudget": { title: "AI budget per widget", type: "number", unit: "tokens a day", default: 200000, min: 0, step: 10000, description: "How much of your AI one widget may use a day. 0: no limit." },
} as const satisfies Record<string, Def>;
