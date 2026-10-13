// Now Playing, a built-in widget: the cover, track and position of whatever the Mac is
// playing (core nowplaying/, read through the MediaRemote adapter), with play/pause,
// skips and a scrubber. The position moves on here from the last report, so the bar
// runs without the core sending every second.

import { EmptyState, IconButton, Inline, Scrubber, Stack, Text, View, formatTime } from "@cmd/ui";
import { useEffect, useState } from "react";
import { nowPlayingPosition, type NowPlaying, type NowPlayingCommand } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import { useWidgetStatus } from "../../lib/widgets.ts";
import type { WindowViewProps } from "../registry.ts";
import "./nowplaying.css";

export function NowPlayingView({ win }: WindowViewProps) {
  const [np, setNp] = useState<NowPlaying | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const off = cmd.onEvent((e) => e.type === "nowPlaying.changed" && setNp(e.nowPlaying));
    void cmd.call("nowPlaying.get", {}).then((n) => live && setNp((cur) => (cur === undefined ? n : cur)));
    return () => ((live = false), off());
  }, []);
  useWidgetStatus(win.id, np ? `${np.title}${np.artist ? ` · ${np.artist}` : ""}` : null);
  const control = (p: { command?: NowPlayingCommand; seek?: number }) => void cmd.call("nowPlaying.control", p);
  return <NowPlayingCard np={np} onControl={control} />;
}

/** The widget, drawn (NowPlayingView.story.tsx shows it playing, paused and empty). */
export function NowPlayingCard({ np, onControl }: { np: NowPlaying | null | undefined; onControl: (p: { command?: NowPlayingCommand; seek?: number }) => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!np?.playing) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [np?.playing]);

  if (np === undefined) return <View />;
  if (np === null) return <View><EmptyState icon="music.note" title="Nothing playing">Play something in Music, Spotify or a browser and it shows here.</EmptyState></View>;
  const pos = nowPlayingPosition(np, now);
  return (
    <View>
      <div className="np">
        <div className="np-art">{np.artwork ? <img src={np.artwork} alt="" draggable={false} /> : <EmptyState icon="music.note" compact />}</div>
        <Stack gap={1}>
          <Text strong truncate>{np.title}</Text>
          <Text tone="dim" truncate>{[np.artist, np.album].filter(Boolean).join(" · ") || " "}</Text>
        </Stack>
        {np.duration !== null && pos !== null && (
          <Stack gap={0.5}>
            <Scrubber duration={np.duration} time={pos} onSeek={(t) => onControl({ seek: t })} label="Position" />
            <Inline justify="between">
              <Text tone="dim" size="sm" mono>{formatTime(pos)}</Text>
              <Text tone="dim" size="sm" mono>−{formatTime(np.duration - pos)}</Text>
            </Inline>
          </Stack>
        )}
        <Inline justify="between">
          <IconButton icon="backward.fill" label="Previous" onClick={() => onControl({ command: "previous" })} />
          <IconButton icon={np.playing ? "pause.fill" : "play.fill"} label={np.playing ? "Pause" : "Play"} onClick={() => onControl({ command: "toggle" })} />
          <IconButton icon="forward.fill" label="Next" onClick={() => onControl({ command: "next" })} />
        </Inline>
      </div>
    </View>
  );
}
