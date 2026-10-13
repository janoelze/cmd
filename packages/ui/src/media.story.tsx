// The Scrubber as the Video window uses it: inline in the toolbar while playing, and over
// the frames while trimming (the handles move the ends, the playhead follows); and the TimeBar, Now Playing's.
import { useState } from "react";
import { Scrubber, TimeBar, type TrimRange } from "./media.tsx";
import { picture } from "./fixtures.ts";

const FRAMES = Array.from({ length: 10 }, (_, i) => picture(190 + i * 12, "", 160, 90));

/** In a toolbar while playing: a thin bar to seek. */
export const Inline = () => {
  const [t, setT] = useState(42);
  return (
    <div style={{ width: 420 }}>
      <Scrubber inline duration={180} time={t} onSeek={setT} />
    </div>
  );
};

/** Trimming: the frames, the kept part between the handles, the playhead. */
export const Trim = () => {
  const [t, setT] = useState(30);
  const [trim, setTrim] = useState<TrimRange>({ start: 12, end: 96 });
  return (
    <div style={{ width: 560 }}>
      <Scrubber duration={180} time={t} onSeek={setT} thumbs={FRAMES} trim={trim} onTrim={(r, end) => (setTrim(r), setT(end === "start" ? r.start : r.end))} />
    </div>
  );
};

/** The TimeBar, as Now Playing draws a track: playing runs on by itself; click or drag to seek. */
export const Time = () => {
  const [t, setT] = useState(42);
  return (
    <div style={{ width: 320, display: "grid", gap: 16 }}>
      <TimeBar duration={180} time={t} playing onSeek={setT} />
      <TimeBar duration={180} time={120} onSeek={() => {}} />
    </div>
  );
};
