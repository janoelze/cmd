// Video window view: the video on the stage, the controls under it in a bar with
// the scrubber, as players have them. Space plays and pauses, ← → step 5 s (⇧: a frame), ⌘T trims: the
// scrubber turns into a strip of frames with a handle at each end, I and O set
// them at the playhead, Return saves the kept part as a new file beside it (the
// core's video.trim, macOS's avconvert: MP4, M4V and MOV), Esc leaves.
// Drawn with the kit: a View, a Stage and a Scrubber (the window-design skill).

import { Button, formatTime, Scrubber, Stage, ToolbarButton, ToolbarGroup, ToolbarMenu, ToolbarSpacer, ToolbarText, View, WindowToolbar, toast, type TrimRange } from "@cmd/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { cmd } from "../../lib/bridge.ts";
import { openPath } from "../../lib/actions.ts";
import { showContextMenu } from "../../lib/context.ts";
import { fileUrl } from "../../pdf/lib.ts";
import { stateStr, type WindowViewProps } from "../registry.ts";

const RATES = [0.5, 1, 1.25, 1.5, 2];
const FRAMES = 12;
/** A frame at 30 fps: what ⇧← and ⇧→ step. */
const FRAME = 1 / 30;

export interface VideoApi {
  /** Writes the kept range next to the file; resolves to the new file's path. */
  saveTrim: (path: string, range: TrimRange) => Promise<string>;
}

const realApi: VideoApi = { saveTrim: (path, r) => cmd.call("video.trim", { path, start: r.start, end: r.end }) };
/** What macOS's avconvert reads (the core trims with it); WebM plays but can't be trimmed. */
const TRIMMABLE = /\.(mp4|m4v|mov)$/i;

/** `count` frames spread over the video, small, as data URLs; from a second, hidden element so playback isn't disturbed. */
function useFrames(src: string, duration: number, on: boolean, count = FRAMES): string[] | null {
  const [frames, setFrames] = useState<string[] | null>(null);
  useEffect(() => {
    if (!on || !duration) return;
    let stop = false;
    const v = document.createElement("video");
    v.crossOrigin = "anonymous";
    v.muted = true;
    v.preload = "auto";
    v.src = src;
    const canvas = document.createElement("canvas");
    const out: string[] = [];
    const next = (i: number) => {
      if (stop || i >= count) return;
      v.currentTime = Math.min(duration - 0.05, ((i + 0.5) / count) * duration);
    };
    v.addEventListener("loadeddata", () => next(0), { once: true });
    v.addEventListener("seeked", () => {
      if (stop) return;
      const h = 88;
      canvas.height = h;
      canvas.width = Math.round((v.videoWidth / v.videoHeight) * h) || 156;
      canvas.getContext("2d")!.drawImage(v, 0, 0, canvas.width, canvas.height);
      out.push(canvas.toDataURL("image/jpeg", 0.7));
      setFrames([...out]);
      next(out.length);
    });
    return () => {
      stop = true;
      v.removeAttribute("src");
      v.load();
    };
  }, [src, duration, on, count]);
  return frames;
}

export function VideoView({ win, focused, api = realApi, initialTrim }: WindowViewProps & { api?: VideoApi; initialTrim?: TrimRange }) {
  const file = stateStr(win, "path") ?? "";
  const [src] = useState(() => fileUrl(file));
  const video = useRef<HTMLVideoElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(typeof win.state.rate === "number" ? win.state.rate : 1);
  const [loop, setLoop] = useState(win.state.loop === true);
  const [muted, setMuted] = useState(win.state.muted === true);
  const [error, setError] = useState(false);
  const [trim, setTrim] = useState<TrimRange | null>(initialTrim ?? null);
  const [saving, setSaving] = useState(false);
  const frames = useFrames(src, duration, !!trim);

  const save = (patch: Record<string, unknown>) => void cmd.call("window.update", { id: win.id, state: patch }).catch(() => {});
  const seek = useCallback((t: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(v.duration || 0, t));
    setTime(v.currentTime);
  }, []);
  const toggle = useCallback(() => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      // Trimming plays the kept part: from its start when the playhead is past it.
      if (trim && (v.currentTime < trim.start || v.currentTime >= trim.end - 0.05)) v.currentTime = trim.start;
      void v.play();
    } else v.pause();
  }, [trim]);

  useEffect(() => {
    if (video.current) video.current.playbackRate = rate;
  }, [rate]);
  useEffect(() => {
    if (focused) body.current?.focus();
  }, [focused]);

  // Smooth playhead while playing; timeupdate alone ticks 4× a second.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = video.current;
      if (v) {
        if (trim && v.currentTime >= trim.end) {
          if (loop) v.currentTime = trim.start;
          else (v.pause(), (v.currentTime = trim.end));
        }
        setTime(v.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, trim, loop]);

  const trimmable = TRIMMABLE.test(file);
  const startTrim = () => {
    const d = duration;
    if (!d || !trimmable) return;
    setTrim({ start: 0, end: d });
  };
  const doneTrim = async () => {
    if (!trim || saving) return;
    setSaving(true);
    try {
      const out = await api.saveTrim(file, trim);
      setTrim(null);
      toast(`Saved “${out.split("/").pop()}”`, { action: { label: "Open", run: () => void openPath(out, "user") } });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save the trimmed video.", { tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? FRAME : 5;
    if (e.key === " ") toggle();
    else if (e.key === "ArrowLeft") seek(time - step);
    else if (e.key === "ArrowRight") seek(time + step);
    else if (e.key === "t" && e.metaKey) trim ? setTrim(null) : startTrim();
    else if (trim && e.key === "i") setTrim({ start: Math.min(time, trim.end - 0.5), end: trim.end });
    else if (trim && e.key === "o") setTrim({ start: trim.start, end: Math.max(time, trim.start + 0.5) });
    else if (trim && e.key === "Enter") void doneTrim();
    else if (trim && e.key === "Escape") setTrim(null);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const rateMenu = () =>
    void showContextMenu(RATES.map((r) => ({ label: `${r}×`, checked: r === rate, run: () => (setRate(r), save({ rate: r })) })));

  const kept = trim ? trim.end - trim.start : 0;
  const bar = (
    <WindowToolbar label="Video" bottom>
      <ToolbarButton icon={playing ? "pause" : "play"} label={playing ? "Pause" : "Play"} shortcut="Space" disabled={!duration} onClick={toggle} />
      {trim ? (
        <>
          <ToolbarText priority={1}>
            {formatTime(trim.start, true)} – {formatTime(trim.end, true)} · {formatTime(kept, true)}
          </ToolbarText>
          <ToolbarSpacer />
          <ToolbarButton label="Cancel" shortcut="Esc" onClick={() => setTrim(null)} />
          <ToolbarButton label={saving ? "Saving…" : "Save Copy"} shortcut="↩" disabled={saving || (trim.start <= 0.05 && trim.end >= duration - 0.05)} onClick={() => void doneTrim()} />
        </>
      ) : (
        <>
          <ToolbarText>{formatTime(time)}</ToolbarText>
          <Scrubber inline duration={duration} time={time} onSeek={seek} />
          <ToolbarText priority={1}>{formatTime(duration)}</ToolbarText>
          <ToolbarMenu label="Speed" onClick={rateMenu} priority={2}>
            {rate}×
          </ToolbarMenu>
          <ToolbarGroup>
            <ToolbarButton icon="repeat" label="Loop" pressed={loop} onClick={() => (setLoop(!loop), save({ loop: !loop }))} priority={1} />
            <ToolbarButton icon={muted ? "speaker-slash" : "speaker-high"} label={muted ? "Unmute" : "Mute"} pressed={muted} onClick={() => (setMuted(!muted), save({ muted: !muted }))} priority={1} />
          </ToolbarGroup>
          <ToolbarButton icon="scissors" label="Trim" shortcut="⌘T" disabled={!duration || !trimmable} tip={trimmable ? undefined : "WebM videos can't be trimmed"} onClick={startTrim} priority={3} />
        </>
      )}
    </WindowToolbar>
  );

  return (
    // Keys bubble from the focused body (display: contents keeps the View the window's child).
    <div onKeyDown={onKeyDown} style={{ display: "contents" }}>
      <View
        scroll={false}
        focusable
        bodyRef={body}
        state={error ? { kind: "error", title: "Can't play this video", text: "It may be in a format cmd can't play. Your default video app may manage.", action: <Button onClick={() => cmd.openPath(file, { from: "user" })}>Open with Default App</Button> } : null}
      >
        <Stage>
          <video
            ref={video}
            src={src}
            crossOrigin="anonymous"
            muted={muted}
            loop={loop && !trim}
            playsInline
            preload="auto"
            style={{ objectFit: "contain" }}
            onClick={toggle}
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              setDuration(v.duration);
              if (typeof win.state.t === "number") v.currentTime = win.state.t;
            }}
            onTimeUpdate={(e) => !playing && setTime(e.currentTarget.currentTime)}
            onPlay={() => setPlaying(true)}
            onPause={(e) => (setPlaying(false), save({ t: e.currentTarget.currentTime }))}
            onError={() => setError(true)}
          />
        </Stage>
        {trim && <Scrubber duration={duration} time={time} onSeek={seek} thumbs={frames ?? []} trim={trim} onTrim={(r, end) => (setTrim(r), seek(end === "start" ? r.start : r.end))} />}
        {bar}
      </View>
    </div>
  );
}
