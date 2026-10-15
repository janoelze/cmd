// One package widget window's process as the host keeps it (host.ts): its package and widget,
// its process, connection and API, its tree, status, timers and the person's last press.

import type { AppWindow, WidgetEnv, WidgetHostStatus, WidgetPermissions, WindowId } from "@cmd/protocol";
import type { WidgetApi } from "../api/adapter.ts";
import type { PackageWidget, WidgetPackage } from "../package.ts";
import type { HostConnection } from "./connection.ts";
import { LogLimit } from "./log-limit.ts";
import { WindowPress } from "./press.ts";
import type { RuntimeProcess } from "./runtime.ts";
import { TreeState } from "./tree.ts";

export interface Instance {
  windowId: WindowId;
  kind: string;
  pkg: WidgetPackage | null;
  widget: PackageWidget | null;
  status: WidgetHostStatus;
  tree: TreeState;
  proc: RuntimeProcess | null;
  token: string | null;
  conn: HostConnection | null;
  /** The window's API, from its start with a grant (frames use it before hello, and without a process). */
  adapter: WidgetApi | null;
  /** The process said hello: the wire is open. */
  hello: boolean;
  subs: Map<number, () => void>;
  crashes: number[];
  /** Why we're stopping it ourselves (null: an exit is a crash). */
  stopping: string | null;
  timers: { stop?: NodeJS.Timeout; restart?: NodeJS.Timeout; hello?: NodeJS.Timeout };
  env: Pick<WidgetEnv, "theme" | "size" | "placement" | "box">;
  config: string;
  /** The person's last press (press.ts). */
  press: WindowPress;
  permissions: WidgetPermissions | null;
  /** The widget's error before it said hello (its main didn't import): an exit then is a load failure, not a crash. */
  loadError: string | null;
  /** Its console as `widget.log`, about 50 lines a second at most (log-limit.ts). */
  logs: LogLimit;
}

/** A window's instance before its first start. */
export function newInstance(w: AppWindow, theme: "light" | "dark", log: ConstructorParameters<typeof LogLimit>[0]): Instance {
  return {
    windowId: w.id,
    kind: w.kind,
    pkg: null,
    widget: null,
    status: { kind: "status", state: "starting" },
    tree: new TreeState(),
    proc: null,
    token: null,
    conn: null,
    adapter: null,
    hello: false,
    subs: new Map(),
    crashes: [],
    stopping: null,
    timers: {},
    env: { theme, size: "regular", box: null, placement: "board" },
    config: "",
    press: new WindowPress(`${w.kind} ${w.id}`),
    permissions: null,
    loadError: null,
    logs: new LogLimit(log),
  };
}
