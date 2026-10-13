// The Now Playing widget playing, paused, without a cover, with nothing playing, and at every size.

import type { NowPlaying } from "@cmd/protocol";
import { AllSizes, RefWindow, type SizeName } from "../../reference/RefWindow.tsx";
import { NowPlayingCard } from "./NowPlayingView.tsx";

const COVER = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#f06"/><stop offset="1" stop-color="#40f"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/></svg>')}`;
const TRACK: NowPlaying = { app: "com.spotify.client", title: "Interdimensional Life", artist: "ooxygen", album: "Rave Rats Volume 1", playing: true, duration: 586, elapsed: 132, at: Date.now(), rate: 1, artwork: COVER };

function W({ size = "regular", np }: { size?: SizeName | readonly [number, number]; np: NowPlaying | null }) {
  return (
    <RefWindow icon="music.note" name="Now Playing" size={size}>
      <NowPlayingCard np={np} onControl={() => {}} />
    </RefWindow>
  );
}

export const Playing = () => <W np={TRACK} />;
export const Paused = () => <W np={{ ...TRACK, playing: false }} />;
export const NoCover = () => <W np={{ ...TRACK, artwork: null }} />;
export const Nothing = () => <W np={null} />;
/** With room: one centred column, like an iPod. */
export const Large = () => <W size={[480, 640]} np={TRACK} />;
/** Really short: the cover a thumbnail in front of the title. */
export const Tiny = () => (
  <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
    <W size={[260, 200]} np={TRACK} />
    <W size={[360, 240]} np={TRACK} />
    <W size={[360, 240]} np={{ ...TRACK, artwork: null }} />
  </div>
);
/** A short title grows with the window; a long one stays at the base size and truncates. */
export const Titles = () => (
  <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
    <W size={[420, 600]} np={{ ...TRACK, title: "Friends" }} />
    <W size={[420, 600]} np={TRACK} />
    <W size={[420, 600]} np={{ ...TRACK, title: "A Very Long Title That Goes On (Extended Club Mix, 2026 Remaster)" }} />
    <W size={[300, 260]} np={{ ...TRACK, title: "Friends" }} />
  </div>
);
export const Sizes = () => <AllSizes render={(s) => <W size={s} np={TRACK} />} />;
