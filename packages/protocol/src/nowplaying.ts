// Now Playing: what the Mac is playing (any app that reports it to macOS: Music,
// Spotify, a browser tab), read by the core through the MediaRemote adapter
// (core nowplaying/), and the controls it takes.

/** What is playing; times in seconds, `at` in ms since the epoch. */
export interface NowPlaying {
  /** The app's bundle id: "com.spotify.client". */
  app: string;
  title: string;
  artist: string | null;
  album: string | null;
  playing: boolean;
  /** Length of the track, when the app says. */
  duration: number | null;
  /** Position at `at`; it moves on at `rate` while playing. */
  elapsed: number | null;
  at: number | null;
  rate: number;
  /** The cover as a data: URL. */
  artwork: string | null;
}

export const NOW_PLAYING_COMMANDS = ["toggle", "next", "previous", "back15", "forward15"] as const;
export type NowPlayingCommand = (typeof NOW_PLAYING_COMMANDS)[number];

/** Where a track is now: its position moved on from `at` while it plays. */
export function nowPlayingPosition(n: Pick<NowPlaying, "elapsed" | "at" | "rate" | "playing" | "duration">, now = Date.now()): number | null {
  if (n.elapsed === null) return null;
  const p = n.playing && n.at !== null ? n.elapsed + ((now - n.at) / 1000) * (n.rate || 1) : n.elapsed;
  return Math.max(0, n.duration === null ? p : Math.min(n.duration, p));
}

export type NowPlayingEvent = { type: "nowPlaying.changed"; nowPlaying: NowPlaying | null };

/** Now Playing's RPC methods, part of `Methods` (rpc.ts). */
export interface NowPlayingMethods {
  /** What is playing (null: nothing, or it can't be read). Changes arrive as nowPlaying.changed while a Now Playing window is open. */
  "nowPlaying.get": { params: Record<string, never>; result: NowPlaying | null };
  /** Play/pause, skip or jump in what is playing; `seek` goes to a position in seconds. */
  "nowPlaying.control": { params: { command?: NowPlayingCommand; seek?: number }; result: null };
}
