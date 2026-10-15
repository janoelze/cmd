// Now Playing as one feature (kernel/features.ts): the widget's type, its methods
// (NowPlayingMethods, protocol nowplaying.ts) and the adapter's stream (adapter.ts), which
// runs only while a Now Playing window is open, or a widget package reads it (holdNowPlaying,
// the widget API's media.get and its live `media` topic), and tells the app each change.

import type { NowPlaying, NowPlayingMethods } from "@cmd/protocol";
import type { CoreContext } from "../kernel/context.ts";
import type { Feature } from "../kernel/features.ts";
import type { HandlerSlice } from "../kernel/handlers.ts";
import type { WindowType } from "../windows/types.ts";
import { NowPlayingStream, nowPlayingAvailable, sendNowPlaying } from "./adapter.ts";

export const nowPlayingType: WindowType<Record<string, never>> = {
  kind: "nowplaying",
  title: "Now Playing",
  icon: "music.note",
  role: "widget",
  description: "The cover and track your Mac is playing, with its controls.",
  create: () => ({ state: {}, title: "Now Playing" }),
  update: (state) => ({ state }),
};

/** One stream per core (tests make several cores), and who else holds it running. */
const streams = new WeakMap<object, { stream: NowPlayingStream; holds: Set<object>; heard: boolean }>();
function entryOf(core: Pick<CoreContext, "broadcast">) {
  let e = streams.get(core);
  if (!e) {
    const stream = new NowPlayingStream();
    const entry = { stream, holds: new Set<object>(), heard: false };
    stream.on("changed", (nowPlaying) => ((entry.heard = true), core.broadcast({ type: "nowPlaying.changed", nowPlaying })));
    streams.set(core, (e = entry));
  }
  return e;
}
const streamOf = (core: Pick<CoreContext, "broadcast">): NowPlayingStream => entryOf(core).stream;

/** Running while a Now Playing window is open or someone holds it. */
function sync(core: Pick<CoreContext, "broadcast" | "windows">): void {
  const e = entryOf(core);
  if (e.holds.size || core.windows.list().some((w) => w.kind === "nowplaying")) e.stream.start();
  else (e.stream.stop(), (e.heard = false));
}

/** How long a first read waits for the stream to say what plays. */
const FIRST_MS = 1500;

/**
 * Keeps the stream running for a reader beside the windows (a widget package's media.get):
 * `read()` is what plays now, waiting a moment for the stream's first word when it just started;
 * `on(fn)` hears each change while held (what the app hears as nowPlaying.changed); `release()`
 * lets it stop again.
 */
export function holdNowPlaying(core: Pick<CoreContext, "broadcast" | "windows">): NowPlayingHold {
  const e = entryOf(core);
  const me = {};
  e.holds.add(me);
  sync(core);
  return {
    read: () =>
      e.heard || !nowPlayingAvailable()
        ? Promise.resolve(e.stream.state)
        : new Promise((resolve) => {
            const done = () => (clearTimeout(t), e.stream.off("changed", done), resolve(e.stream.state));
            const t = setTimeout(done, FIRST_MS);
            e.stream.on("changed", done);
          }),
    on(fn) {
      e.stream.on("changed", fn);
      return () => void e.stream.off("changed", fn);
    },
    release() {
      if (e.holds.delete(me)) sync(core);
    },
  };
}

/** The stream kept running for one reader (holdNowPlaying). */
export interface NowPlayingHold {
  read(): Promise<NowPlaying | null>;
  /** Hears each change; returns what stops it. */
  on(fn: () => void): () => void;
  release(): void;
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
      const again = () => sync(core);
      core.windows.on("updated", again);
      core.windows.on("removed", again);
      again();
    },
  },
  dispose: (core: CoreContext) => streams.get(core)?.stream.stop(),
} satisfies Feature;
