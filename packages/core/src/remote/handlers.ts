// Remote access's methods (remote.*, docs/13 and 38): turn it on, pair and approve devices,
// access modes, and a session's bootstrap (what a paired device loads first, and the events
// it gets from then on: those of the windows it shows and the files it watches), and a
// device's push subscription.

import { execFileSync } from "node:child_process";
import os from "node:os";
import type { RemoteScope, Result } from "@cmd/protocol";
import type { Connection } from "../kernel/connection.ts";
import type { CoreContext } from "../kernel/context.ts";
import { IN_CORE, slice } from "../kernel/handlers.ts";
import { remoteEvent } from "./policy.ts";
import { remoteTheme } from "./service.ts";

export const remoteHandlers = (core: CoreContext) =>
  slice({
    "remote.status": () => core.remote.status(),
    "remote.enable": async () => (core.settings.set("remote.enabled", true), await core.remote.ready(), core.remote.status()),
    "remote.disable": async () => (core.settings.set("remote.enabled", false), await core.remote.ready(), core.remote.status()),
    "remote.pair": (p) => core.remote.pair(p.scope ?? "view"),
    "remote.approve": (p) => (core.remote.approve(p.requestId, p.allow, p.scope), null),
    "remote.devices": () => core.remote.devices(),
    "remote.disconnect": (p) => (core.remote.disconnect(p.id), null),
    "remote.log": (p) => core.remote.log(p.limit),
    "remote.modes": () => core.remote.modeList(),
    "remote.checks": (p) => core.remote.checks(p.access),
    "remote.setup": () => core.remote.setup(),
    "remote.revoke": (p) => (core.remote.revoke(p.id), null),
    "remote.setScope": (p) => core.remote.setScope(p.id, p.scope),
    "remote.ack": (p, { conn } = IN_CORE) => (conn?.ack?.(p.received), null),
    "remote.bootstrap": (_, { conn } = IN_CORE) => {
      const result: Result<"remote.bootstrap"> = {
        panes: core.panes.list(),
        agents: core.agents.list(),
        windows: core.windows.others(),
        workspaces: core.workspaces.list(),
        windowTypes: core.windowTypes.info(),
        device: null,
        host: { name: computerName() },
        theme: remoteTheme(core.settings.settings),
      };
      if (conn) {
        if (conn.deviceId) {
          result.device = { id: conn.deviceId, scope: conn.access as RemoteScope };
          const push = core.remote.push.info(conn.deviceId);
          if (push) result.push = push;
        }
        const state = core.server.state(conn);
        core.server.subscribe(conn, (e) => remoteEvent(e, core.server.policy(), state.follows, state.watches, conn.access === "control" ? "control" : "view"));
      }
      return result;
    },
    // A paired device's own: its subscription is kept on its record (docs/13, "Push notifications").
    "push.subscribe": (p, { conn } = IN_CORE) => (core.remote.push.subscribe(device(conn), p), null),
    "push.unsubscribe": (_, { conn } = IN_CORE) => (core.remote.push.unsubscribe(device(conn)), null),
    "push.visible": (p, { conn } = IN_CORE) => (core.remote.visible(device(conn), p.visible === true), null),
    // The Mac's own app: whether someone's at this Mac, for remote.push.when "away".
    "ui.presence": (p, { conn } = IN_CORE) => (core.remote.push.presence(conn, p), null),
  });

/** The paired device's connection behind a call; nobody else has notifications to switch. */
function device(conn: Connection | null): Connection {
  if (!conn || conn.access === "local") throw new Error("only paired devices get notifications");
  return conn;
}

let hostName: string | null = null;
/** The Mac's name as set in System Settings ("Jan's MacBook Pro"), else the host name. */
function computerName(): string {
  if (hostName) return hostName;
  try {
    if (process.platform === "darwin") hostName = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim();
  } catch {}
  return (hostName ||= os.hostname().replace(/\.local$/, ""));
}
