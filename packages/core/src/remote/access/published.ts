// A port publisher (adapter.ts) as an access mode (mode.ts): the core's loopback
// DirectListener, made reachable by the adapter. Publishing runs alongside the
// listener; the listener comes online once the adapter reports its URL. The
// publication outlives restarts of the same mode with the same settings (Check
// Again, a core restart), and is undone when the mode is switched away from,
// turned off, or one of its settings changes.
// "Check Again" restarts a listener that isn't online, so the adapter publishes again.

import type { Settings } from "@cmd/protocol";
import { defaultDirectPort, DirectListener } from "../direct.ts";
import type { AccessAdapter, AdapterContext } from "./adapter.ts";
import type { AccessMode, ModeContext } from "./mode.ts";

export const localPort = (s: Settings): number => s["remote.port"] || defaultDirectPort();

export function publishedMode(a: AccessAdapter): AccessMode {
  /** The listener of the current run; null once stopped. */
  let listener: DirectListener | null = null;
  /** Whether the mode should be published: running, or stopped to start again. */
  let active = false;
  /** What the adapter published and with what, to undo it. */
  let published: { ctx: AdapterContext; key: string } | null = null;
  /** The adapter's enable() for the current listener, settled. */
  let enabling: Promise<void> = Promise.resolve();

  const settings = [...a.settings, "remote.port"] as const;
  /** What a publication depends on: another value means unpublishing first. */
  const publishKey = (s: Settings) => JSON.stringify([localPort(s), ...a.settings.map((k) => s[k])]);

  /** The settings as they are now: disable() then undoes what enable() did, even after they changed. */
  const context = (ctx: ModeContext, port: number, route: string): AdapterContext => ({
    exec: ctx.exec,
    settings: ctx.settings,
    port,
    route,
    log: ctx.log,
  });

  async function unpublish(ctx: ModeContext): Promise<void> {
    const p = published;
    published = null;
    try {
      await a.disable(p!.ctx);
    } catch (err) {
      ctx.log.warn(`${a.id}: couldn't unpublish: ${(err as Error).message}`);
    }
  }

  return {
    id: a.id,
    title: a.title,
    icon: a.icon,
    description: a.description,
    settings,
    argument: a.argument,
    connecting: a.connecting,
    config: (s) => settings.map((k) => s[k]),

    detect: (ctx) => a.detect(context(ctx, localPort(ctx.settings), ctx.keys.directRoute(a.id))),

    async setup(ctx) {
      if (ctx.settings["remote.enabled"] && listener?.state !== "online") {
        await ctx.restart();
        await enabling;
      }
      return this.detect!(ctx);
    },

    start(ctx) {
      const port = localPort(ctx.settings);
      const route = ctx.keys.directRoute(a.id);
      const l = new DirectListener({ port, route, webDir: ctx.webDir });
      listener = l;
      active = true;
      ctx.audit("enabled", `${a.id} on 127.0.0.1:${port}`);
      const actx = context(ctx, port, route);
      const key = publishKey(ctx.settings);
      enabling = a.enable(actx).then(
        ({ url }) => {
          if (listener === l) {
            published = { ctx: actx, key };
            l.setOrigin(url);
          } else if (!active) {
            // Turned off while it was publishing.
            void a.disable(actx).catch(() => {});
          }
        },
        (err: Error) => {
          ctx.log.warn(`${a.id}: ${err.message}`);
          if (listener === l) l.setOrigin(null, err.message);
        },
      );
      return l;
    },

    async stop(ctx, { restart }) {
      listener = null;
      active = restart;
      if (published && (!restart || published.key !== publishKey(ctx.settings))) await unpublish(ctx);
    },
  };
}
