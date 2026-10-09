// A port publisher (adapter.ts) as an access mode (mode.ts): the core's loopback
// DirectListener, made reachable by the adapter. Publishing runs alongside the
// listener; the listener comes online once the adapter reports its URL. The mode
// is stateless; each run keeps its own listener and publication. A publication
// outlives restarts of the same mode with the same publish key (Check Again, a
// setting it doesn't publish with, a core restart): stop({ restart }) hands it to
// the next run. It's undone when the mode is switched away from, turned off, or
// one of its settings changes, with the settings it was published with.
// "Check Again" republishes a listener that isn't online, without restarting it.

import type { Settings } from "@cmd/protocol";
import { defaultDirectPort, DirectListener } from "../direct.ts";
import type { AccessAdapter, AdapterContext } from "./adapter.ts";
import type { AccessMode, AccessRun, ModeContext } from "./mode.ts";

export const localPort = (s: Settings): number => s["remote.port"] || defaultDirectPort();

/** What the adapter published, and with what, to undo it. */
export interface Publication {
  /** What it depends on: another value means unpublishing first. */
  key: string;
  ctx: AdapterContext;
}

export function publishedMode(a: AccessAdapter): AccessMode<Publication> {
  const settings = [...a.settings, "remote.port"] as const;
  const publishKey = (s: Settings) => JSON.stringify([localPort(s), ...a.settings.map((k) => s[k])]);

  /** The settings as they are now: disable() then undoes what enable() did, even after they changed. */
  const context = <R extends string | null>(ctx: ModeContext, port: number, route: R): AdapterContext & { route: R } => ({
    exec: ctx.exec,
    settings: ctx.settings,
    selected: ctx.selected,
    port,
    route,
    log: ctx.log,
  });

  return {
    id: a.id,
    title: a.title,
    icon: a.icon,
    description: a.description,
    settings,
    argument: a.argument,
    connecting: a.connecting,
    config: (s) => settings.map((k) => s[k]),

    detect: (ctx) => a.detect(context(ctx, localPort(ctx.settings), ctx.keys.peekDirectRoute(a.id))),

    start(ctx, carried): AccessRun<Publication> {
      const port = localPort(ctx.settings);
      const route = ctx.keys.directRoute(a.id);
      const l = new DirectListener({ port, route, webDir: ctx.webDir });
      ctx.audit("enabled", `${a.id} on 127.0.0.1:${port}`);
      const actx = context(ctx, port, route);
      const key = publishKey(ctx.settings);
      /** What's published and ours to undo: the previous run's until this one publishes. */
      let published: Publication | null = carried;
      /** null while it runs; handed: its publication went to the next run; unpublished: undone (or to be, once enable settles). */
      let ended: "handed" | "unpublished" | null = null;
      let undone = false;
      /** At most once a run: a pending enable and the one it replaces publish the same thing. */
      const undo = async (p: AdapterContext) => {
        if (undone) return;
        undone = true;
        try {
          await a.disable(p);
        } catch (err) {
          ctx.log.warn(`${a.id}: couldn't unpublish: ${(err as Error).message}`);
        }
      };
      const publish = () =>
        a.enable(actx).then(
          ({ url }) => {
            if (ended === null) {
              published = { key, ctx: actx };
              l.setOrigin(url);
            } else if (ended === "unpublished") {
              // Turned off, or its settings changed, while it was publishing.
              void undo(actx);
            }
            // handed: the next run publishes again itself.
          },
          (err: Error) => {
            ctx.log.warn(`${a.id}: ${err.message}`);
            if (ended === null) l.setOrigin(null, err.message);
          },
        );
      /** The adapter's latest enable(), settled. */
      let enabling = publish();

      return {
        transport: l,

        async retry() {
          if (l.state === "online") return;
          // The listener itself failed (its port was taken): listen again, and wait for it
          // (a second at most: the same error again changes no state).
          if (l.port === null && l.state === "error") {
            l.close();
            const listened = new Promise<void>((resolve) => {
              const done = () => (clearTimeout(timer), l.off("state", done), resolve());
              const timer = setTimeout(done, 1000);
              l.on("state", done);
            });
            l.start();
            await listened;
          }
          await enabling;
          if (ended === null && !l.endpoint()) await (enabling = publish());
        },

        async stop({ restart }) {
          if (restart && key === publishKey(ctx.settings)) {
            ended = "handed";
            return published;
          }
          ended = "unpublished";
          if (published) await undo(published.ctx);
          return null;
        },
      };
    },
  };
}
