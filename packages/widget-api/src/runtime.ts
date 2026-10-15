// The widget process's entry (docs/56, "The runtime"): given a transport to the core and
// the widget module's default export, it says hello, waits for `ready` (env, config, the
// window's stored state), runs the storage migration it asks for (1.3), renders, and from then on routes `interaction`s to handlers,
// `event`s to subscriptions and `resync` to a full tree. It knows nothing of sockets or
// Deno: the host process (item C) hands it a Transport over the widgets socket, tests an
// in-memory one.

import { createElement, isValidElement, type ComponentType, type ReactNode } from "react";
import { WIDGET_API, WIDGET_API_MINOR } from "./version.ts";
import { Connection, setConnection, type Transport } from "./connection.ts";
import { TreeRoot } from "./reconciler.ts";
import { migrationFailed, runMigration } from "./storage.ts";

/** Who is running: package.json's name and version, and the widget's id in `cmd.widgets[]`. */
export interface WidgetInfo {
  package: string;
  version: string;
  widget: string;
}

export interface RunOptions extends WidgetInfo {
  /** Send console.* to the core as `log` messages (the widget process: yes; tests: no). */
  captureConsole?: boolean;
}

/** A running widget. */
export interface Running {
  connection: Connection;
  root: TreeRoot;
  /** Unmounts (subscriptions end with `unsubscribe`s, the last patch empties the tree) and closes the connection. */
  stop(): void;
}

/** A module's default export: a component (or defineWidget's), or an element. */
export type WidgetModule = ComponentType<Record<string, never>> | ReactNode;

/** Renders `widget` on a connection that is ready. */
export function mount(conn: Connection, widget: WidgetModule): TreeRoot {
  setConnection(conn);
  const root = new TreeRoot(conn);
  root.render(isValidElement(widget) ? widget : typeof widget === "function" ? createElement(widget as ComponentType) : (widget as ReactNode));
  return root;
}

/** Runs a widget over `transport`: hello, ready, render. */
export async function run(transport: Transport, widget: WidgetModule, opts: RunOptions): Promise<Running> {
  const conn = new Connection(transport);
  conn.send({ kind: "hello", api: WIDGET_API, minor: WIDGET_API_MINOR, package: opts.package, version: opts.version, widget: opts.widget });
  await conn.ready;
  const restore = opts.captureConsole ? captureConsole(conn) : null;
  setConnection(conn);
  // A migration due runs before anything renders (and reads storage); one that throws shows why instead of the widget.
  const failed = conn.migrate ? await runMigration(conn, conn.migrate) : null;
  const root = mount(conn, failed === null ? widget : createElement(Failed, { message: migrationFailed(failed) }));
  return {
    connection: conn,
    root,
    stop() {
      root.unmount();
      restore?.();
      conn.close();
      setConnection(null);
    },
  };
}

/** What the window shows when the migration threw: the reconciler's boundary draws the error. */
function Failed({ message }: { message: string }): ReactNode {
  throw new Error(message);
}

const LEVELS = { debug: "debug", log: "info", info: "info", warn: "warn", error: "error" } as const;

const show = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};

/** console.* as `log` messages; returns what puts console back. */
function captureConsole(conn: Connection): () => void {
  const c = console as unknown as Record<string, (...a: unknown[]) => void>;
  const saved = new Map<string, (...a: unknown[]) => void>();
  for (const [name, level] of Object.entries(LEVELS)) {
    saved.set(name, c[name]!);
    c[name] = (...args: unknown[]) => conn.send({ kind: "log", level, message: args.map(show).join(" ") });
  }
  return () => {
    for (const [name, fn] of saved) c[name] = fn;
  };
}
