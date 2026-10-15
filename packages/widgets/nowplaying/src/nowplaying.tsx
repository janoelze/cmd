// Media Controls, a built-in widget package (docs/57, wave 2; the native Now Playing's job):
// whatever the Mac is playing (cmd.media.get, API 1.2): the track, its artist and album, where
// it is on a scrubber with the time gone and left, and Previous, Play or Pause, Next. Each
// control and each seek is one press, one `cmd.media.control`. The API has no live topic for
// it, so it asks every 2 seconds (the core holds the Mac's stream open and answers from it);
// between answers the scrubber moves on by itself. Nothing playing, refused, or failed: a
// state that says so. No footer, as natively; a control that didn't go through says why in one.

import { Window, View, Stack, Inline, Text, Icon, IconButton, TimeBar, StatusLine, useData, useNow, useEnv, cmd, ApiCallError, type NowPlaying, type MediaCommand } from "@cmd/widget-api";
import { useMemo, useState } from "react";

/** How often it asks what plays, in seconds. */
export const EVERY = 2;

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

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function Player({ np, refresh }: { np: NowPlaying; refresh: () => void }) {
  const [failed, setFailed] = useState<string | null>(null);
  const now = useNow(np.playing ? 1000 : 60_000);
  // The scrubber gets a new time only when the player reports one; it moves on by itself between.
  const reported = useMemo(() => position(np), [np.elapsed, np.at, np.playing, np.rate, np.duration]);
  const pos = position(np, now);
  const control = (command: MediaCommand | null, seek?: number) =>
    void cmd.media
      .control(command, seek === undefined ? undefined : { seek })
      .then(() => (setFailed(null), refresh()))
      .catch((e: unknown) => setFailed(e instanceof ApiCallError && e.code === "permission" ? "Controlling what plays isn't allowed for this widget" : `Couldn't reach the player: ${e instanceof Error ? e.message : String(e)}`));

  return (
    <View inset>
      <Stack gap={4}>
        <Inline gap={3}>
          <Icon name="music.note" size={22} />
          <Stack gap={0.5} grow>
            <Text size="lg" strong truncate>
              {np.title}
            </Text>
            <Text tone="dim" truncate>
              {[np.artist, np.album].filter(Boolean).join(" · ") || " "}
            </Text>
          </Stack>
        </Inline>
        {np.duration !== null && pos !== null && reported !== null && (
          <Stack gap={1}>
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
        )}
        <Stack align="center">
          <Inline gap={2}>
            <IconButton icon="backward.fill" label="Previous" size="lg" onClick={() => control("previous")} />
            <IconButton icon={np.playing ? "pause.fill" : "play.fill"} label={np.playing ? "Pause" : "Play"} size="lg" onClick={() => control("toggle")} />
            <IconButton icon="forward.fill" label="Next" size="lg" onClick={() => control("next")} />
          </Inline>
        </Stack>
      </Stack>
      {failed && <StatusLine>{failed}</StatusLine>}
    </View>
  );
}

export default function MediaControls() {
  const served = cmd.env.has("media.get");
  const { data, error, refresh } = useData(() => (served ? cmd.media.get() : Promise.resolve(null)), { every: served ? EVERY : 0 });
  const refused = error instanceof ApiCallError && error.code === "permission";
  const np = refused ? null : (data ?? null);
  // The title bar's line: what plays, cut short; none in a narrow window, where the track is right under it.
  const narrow = useEnv().size === "narrow";
  const line = np && !narrow ? clip([np.title, np.artist].filter(Boolean).join(" · "), 40) : null;

  const state = !served
    ? { icon: "music.note", title: "Needs a newer cmd", text: "Update cmd to see what's playing here." }
    : refused
      ? { kind: "error" as const, title: "What's playing isn't shared with this widget", text: error.message }
      : data === undefined && error
        ? { kind: "error" as const, title: "Couldn't see what's playing", text: error.message, action: { label: "Try Again", run: refresh } }
        : data === undefined
          ? { kind: "loading" as const, title: "Looking for what's playing" }
          : data === null
            ? { icon: "music.note", title: "Nothing playing", text: "Play something in Music, Spotify or a browser and it shows here." }
            : null;

  return (
    <Window status={line}>
      {state || !np ? <View state={state} /> : <Player np={np} refresh={refresh} />}
    </Window>
  );
}
