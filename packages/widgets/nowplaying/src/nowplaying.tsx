// Media Controls, a built-in widget package (docs/57; the native Now Playing's job and looks):
// whatever the Mac is playing, live (useMedia, API 1.3: a change of track or a pause from
// anywhere shows at once): its cover, the track, its artist and album, where it is on a
// scrubber with the time gone and left, and Previous, Play or Pause, Next. Each control and
// each seek is one press, one `cmd.media.control`; the change comes back through useMedia.
// Three faces in an Adapt, at the native view's numbers: short (up to 280 px tall) a thumbnail
// in front of the title with the player at the bottom; large (from 340×440) a centred column
// under the cover, like an iPod; otherwise the cover takes the room above the track. Nothing
// playing: a state that says so. No footer, as natively; a control that didn't go through
// says why in one.

import { Adapt, Case, Window, View, Stack, Inline, Text, IconButton, Picture, TimeBar, StatusLine, useMedia, useNow, cmd, ApiCallError, type NowPlaying, type MediaCommand } from "@cmd/widget-api";
import { useMemo, useState } from "react";

/** The position now: from the last report, moving on at its rate while playing, within the track. */
export function position(n: Pick<NowPlaying, "elapsed" | "at" | "rate" | "playing" | "duration">, now = Date.now()): number | null {
  if (n.elapsed === null) return null;
  const p = n.playing && n.at !== null ? n.elapsed + ((now - n.at) / 1000) * (n.rate || 1) : n.elapsed;
  return Math.max(0, n.duration === null ? p : Math.min(n.duration, p));
}

/** Seconds as a player writes them: "3:07", "1:02:09". */
export function clock(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** The native view's faces: short up to this height; large from this width and height. */
export const SHORT = 280;
export const LARGE = { width: 340, height: 440 } as const;

type Control = (command: MediaCommand | null, seek?: number) => void;

/** The cover: as large as the room allows, or a thumbnail; its box with a note when the player sent none. */
const Cover = ({ np, thumb }: { np: NowPlaying; thumb?: boolean }) => <Picture src={np.artwork} alt={np.album ? `${np.album} cover` : "Cover"} icon="music.note" size={thumb ? 44 : "fill"} radius={thumb ? "sm" : undefined} />;

/** The artist and album, or a blank line that keeps the place. */
const Byline = ({ np }: { np: NowPlaying }) => (
  <Text tone="dim" truncate>
    {[np.artist, np.album].filter(Boolean).join(" · ") || " "}
  </Text>
);

/** Where it is: the scrubber (it moves on by itself between reports) with the time gone and left; none for a stream without a length. */
function Progress({ np, control }: { np: NowPlaying; control: Control }) {
  const now = useNow(np.playing ? 1000 : 60_000);
  // The scrubber gets a new time only when the player reports one.
  const reported = useMemo(() => position(np), [np.elapsed, np.at, np.playing, np.rate, np.duration]);
  const pos = position(np, now);
  if (np.duration === null || pos === null || reported === null) return null;
  return (
    <Stack gap={1.5}>
      <TimeBar duration={np.duration} time={reported} playing={np.playing} rate={np.rate || 1} onSeek={(t) => control(null, Math.max(0, t))} />
      <Inline justify="between">
        <Text tone="dim" size="sm" mono>
          {clock(pos)}
        </Text>
        <Text tone="dim" size="sm" mono>
          {`−${clock(np.duration - pos)}`}
        </Text>
      </Inline>
    </Stack>
  );
}

/** Previous, Play or Pause, Next: spread across the width, or centred and apart (large). */
function Controls({ np, control, centred }: { np: NowPlaying; control: Control; centred?: boolean }) {
  const buttons = (
    <Inline gap={centred ? 6 : undefined} justify={centred ? undefined : "between"}>
      <IconButton icon="backward.fill" label="Previous" onClick={() => control("previous")} />
      <IconButton icon={np.playing ? "pause.fill" : "play.fill"} label={np.playing ? "Pause" : "Play"} onClick={() => control("toggle")} />
      <IconButton icon="forward.fill" label="Next" onClick={() => control("next")} />
    </Inline>
  );
  return centred ? <Stack align="center">{buttons}</Stack> : buttons;
}

function Player({ np }: { np: NowPlaying }) {
  const [failed, setFailed] = useState<string | null>(null);
  const control: Control = (command, seek) =>
    void cmd.media
      .control(command, seek === undefined ? undefined : { seek })
      .then(() => setFailed(null))
      .catch((e: unknown) => setFailed(e instanceof ApiCallError && e.code === "permission" ? "Controlling what plays isn't allowed for this widget" : `Couldn't reach the player: ${e instanceof Error ? e.message : String(e)}`));

  return (
    <View scroll={false}>
      <Adapt>
        <Case maxHeight={SHORT}>
          <Stack pad="inset" gap={3} grow justify="between">
            <Inline gap={3}>
              <Cover np={np} thumb />
              <Stack gap={1} grow>
                <Text size="lg" strong truncate>
                  {np.title}
                </Text>
                <Byline np={np} />
              </Stack>
            </Inline>
            <Stack gap={3}>
              <Progress np={np} control={control} />
              <Controls np={np} control={control} />
            </Stack>
          </Stack>
        </Case>
        <Case minWidth={LARGE.width} minHeight={LARGE.height}>
          <Stack pad="inset" gap={4} grow>
            <Cover np={np} />
            <Stack gap={1} align="center">
              <Text size="lg" strong fit>
                {np.title}
              </Text>
              <Byline np={np} />
            </Stack>
            <Progress np={np} control={control} />
            <Controls np={np} control={control} centred />
          </Stack>
        </Case>
        <Case>
          <Stack pad="inset" gap={3} grow>
            <Cover np={np} />
            <Stack gap={1}>
              <Text size="lg" strong fit>
                {np.title}
              </Text>
              <Byline np={np} />
            </Stack>
            <Progress np={np} control={control} />
            <Controls np={np} control={control} />
          </Stack>
        </Case>
      </Adapt>
      {failed && <StatusLine>{failed}</StatusLine>}
    </View>
  );
}

function Live() {
  const np = useMedia();
  return (
    <Window status={np ? [np.title, np.artist].filter(Boolean).join(" · ") : null}>
      {np ? <Player np={np} /> : <View state={{ icon: "music.note", title: "Nothing playing", text: "Play something in Music, Spotify or a browser and it shows here." }} />}
    </Window>
  );
}

export default function MediaControls() {
  // useMedia, Adapt and Picture came in API 1.3.
  if (cmd.env.has("Adapt")) return <Live />;
  return (
    <Window>
      <View state={{ icon: "music.note", title: "Needs a newer cmd", text: "Update cmd to see what's playing here." }} />
    </Window>
  );
}
