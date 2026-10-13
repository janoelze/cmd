// Now Playing as one feature (kernel/features.ts): the widget's type, its methods
// (NowPlayingMethods, protocol nowplaying.ts) and the adapter's stream (adapter.ts), which
// runs only while a Now Playing window is open and tells the app each change.

import type { NowPlayingMethods } from "@cmd/protocol";
import type { CoreContext } from "../kernel/context.ts";
import type { Feature } from "../kernel/features.ts";
import type { HandlerSlice } from "../kernel/handlers.ts";
import type { WindowType } from "../windows/types.ts";
import { NowPlayingStream, sendNowPlaying } from "./adapter.ts";

export const nowPlayingType: WindowType<Record<string, never>> = {
  kind: "nowplaying",
  title: "Now Playing",
  icon: "music.note",
  role: "widget",
  description: "The cover and track your Mac is playing, with its controls.",
  create: () => ({ state: {}, title: "Now Playing" }),
  update: (state) => ({ state }),
};

/** One stream per core (tests make several cores). */
const streams = new WeakMap<CoreContext, NowPlayingStream>();
function streamOf(core: CoreContext): NowPlayingStream {
  let s = streams.get(core);
  if (!s) {
    s = new NowPlayingStream();
    s.on("changed", (nowPlaying) => core.broadcast({ type: "nowPlaying.changed", nowPlaying }));
    streams.set(core, s);
  }
  return s;
}

export const nowPlayingFeature = {
  id: "nowplaying",
  prefixes: ["nowPlaying"],
  handlers: (core: CoreContext): HandlerSlice<keyof NowPlayingMethods> => ({
    "nowPlaying.get": () => streamOf(core).state,
    "nowPlaying.control": async (p) => (await sendNowPlaying(p), null),
  }),
  startup: {
    label: "Listening for Now Playing",
    run: (core: CoreContext) => {
      const s = streamOf(core);
      const sync = () => (core.windows.list().some((w) => w.kind === "nowplaying") ? s.start() : s.stop());
      core.windows.on("updated", sync);
      core.windows.on("removed", sync);
      sync();
    },
  },
  dispose: (core: CoreContext) => streams.get(core)?.stop(),
} satisfies Feature;
