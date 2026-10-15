// Media Controls' states for the UI Workbench (`pnpm workbench widgets/nowplaying`): the widget
// against the fake host, one variant per state, each the host's data.

import type { HostData } from "@cmd/widget-api/testing/host";
import { playing } from "@cmd/widget-api/testing/fixtures";
import MediaControls from "./nowplaying.tsx";

export default MediaControls;

const track = playing({ app: "com.spotify.client", title: "Teardrop", artist: "Massive Attack", album: "Mezzanine", duration: 330, elapsed: 75 });

/** A track playing in Spotify. */
export const Playing: HostData = { playing: track };

/** Paused halfway. */
export const Paused: HostData = { playing: { ...track, playing: false, elapsed: 165 } };

/** A long title, in a narrow window, as in a sidebar. */
export const Narrow: HostData & { size: "narrow" } = { playing: playing({ app: "com.apple.Music", title: "Concerto for Two Violins in D Minor, BWV 1043: II. Largo ma non tanto", artist: "Hilary Hahn, Margaret Batjer, Los Angeles Chamber Orchestra", album: "Bach: Violin Concertos", duration: 412, elapsed: 30 }), size: "narrow" };

/** A stream without a length: no scrubber. */
export const Stream: HostData = { playing: playing({ app: "com.apple.Safari", title: "Radio Paradise · Main Mix", artist: null, album: null, duration: null, elapsed: null }) };

/** Nothing playing on the Mac. */
export const Nothing: HostData = { playing: null };

/** Reading what plays refused: the grant lacks media. */
export const Refused: HostData = { playing: track, deny: { "media.get": 'media: ["read"]' } };
