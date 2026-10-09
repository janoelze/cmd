// What Visualizer windows listen to: one AudioContext for this page (a workspace's
// windows share it) and the sources it can tap.
//   "none"        silence
//   "mic"         the default input (macOS asks once; NSMicrophoneUsageDescription)
//   "system"      what the Mac plays (getDisplayMedia with loopback audio, main/index.ts)
//   "window:<id>" a window that makes sound (Jam) and publishes its levels here
// Microphone and system audio are opened once, while a Visualizer listens, and
// never played back. A tap reads 1024 samples per channel each frame, the
// shape butterchurn's audioLevels takes. A window's sound is made in its own
// sandboxed frame, so it publishes those samples, not an audio node, and is
// told when someone listens (it only sends them then). Windows in other workspaces are other
// pages: their sound can't be tapped from here.

export const FFT_SIZE = 1024;

export interface AudioSource {
  id: string;
  label: string;
}

let ctx: AudioContext | null = null;
export function audioContext(): AudioContext {
  ctx ??= new AudioContext({ latencyHint: "interactive" });
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

// ── sources windows publish ─────────────────────────────

/** A window's sound: its latest samples, and whether anyone wants them. */
export interface LevelsSource {
  read(): Levels | null;
  listen(on: boolean): void;
}

const published = new Map<string, { label: string; source: LevelsSource; listeners: number }>();
const listeners = new Set<() => void>();
let snapshot: AudioSource[] = [];
const changed = () => {
  snapshot = [...published].map(([id, s]) => ({ id, label: s.label }));
  for (const l of listeners) l();
};

/** A window offers its sound as "window:<id>"; the returned function withdraws it. */
export function publishLevels(windowId: string, label: string, source: LevelsSource): () => void {
  const id = `window:${windowId}`;
  published.set(id, { label, source, listeners: 0 });
  changed();
  return () => {
    if (published.get(id)?.source !== source) return;
    published.delete(id);
    changed();
  };
}

/** The windows playing into this page right now. */
export const publishedSources = (): AudioSource[] => snapshot;

// ── microphone and system audio, shared while in use ────

const streams = new Map<string, { node: Promise<MediaStreamAudioSourceNode>; users: number }>();

function openStream(id: "mic" | "system"): Promise<MediaStreamAudioSourceNode> {
  const open = async () => {
    const stream =
      id === "mic"
        ? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    // System audio comes with a video track (the app's own page, see main): not needed.
    for (const t of stream.getVideoTracks()) t.stop();
    if (!stream.getAudioTracks().length) throw new Error(id === "mic" ? "No microphone" : "No system audio");
    return audioContext().createMediaStreamSource(stream);
  };
  let s = streams.get(id);
  if (!s) streams.set(id, (s = { node: open(), users: 0 }));
  s.users++;
  s.node.catch(() => streams.get(id) === s && streams.delete(id));
  return s.node;
}

function closeStream(id: "mic" | "system"): void {
  const s = streams.get(id);
  if (!s || --s.users > 0) return;
  streams.delete(id);
  void s.node.then((n) => {
    n.disconnect();
    for (const t of n.mediaStream.getTracks()) t.stop();
  }, () => {});
}

// ── taps ────────────────────────────────────────────────

export interface Levels {
  t: Uint8Array<ArrayBuffer>;
  l: Uint8Array<ArrayBuffer>;
  r: Uint8Array<ArrayBuffer>;
}

/**
 * Listen to a source. `read()` gives this frame's samples (silence until the
 * source is there; a window's that isn't published yet is picked up when it is).
 * `onError` hears why a source can't be opened (permission denied, …).
 */
export function tap(source: string, onError: (err: Error) => void): { read(): Levels; close(): void } {
  if (source.startsWith("window:")) {
    // Follow the window as it comes and goes, and tell it while we listen.
    let entry: { source: LevelsSource; listeners: number } | undefined;
    const silence = { t: new Uint8Array(FFT_SIZE).fill(128), l: new Uint8Array(FFT_SIZE).fill(128), r: new Uint8Array(FFT_SIZE).fill(128) };
    const follow = () => {
      const next = published.get(source);
      if (next === entry) return;
      if (entry && --entry.listeners === 0) entry.source.listen(false);
      entry = next;
      if (entry && entry.listeners++ === 0) entry.source.listen(true);
    };
    listeners.add(follow);
    const unlisten = () => {
      listeners.delete(follow);
      if (entry && --entry.listeners === 0) entry.source.listen(false);
      entry = undefined;
    };
    follow();
    return { read: () => entry?.source.read() ?? silence, close: unlisten };
  }

  const c = audioContext();
  const analyser = (n: AudioNode) => {
    const a = c.createAnalyser();
    a.fftSize = FFT_SIZE;
    a.smoothingTimeConstant = 0;
    n.connect(a);
    return a;
  };
  // Two channels always: mono inputs are copied to both sides, so presets that look at left and right still move.
  const input = c.createGain();
  input.channelCountMode = "explicit";
  input.channelCount = 2;
  const split = c.createChannelSplitter(2);
  input.connect(split);
  const mono = analyser(input), left = c.createAnalyser(), right = c.createAnalyser();
  for (const [a, ch] of [[left, 0], [right, 1]] as const) {
    a.fftSize = FFT_SIZE;
    a.smoothingTimeConstant = 0;
    split.connect(a, ch);
  }
  const levels: Levels = { t: new Uint8Array(FFT_SIZE), l: new Uint8Array(FFT_SIZE), r: new Uint8Array(FFT_SIZE) };

  let from: AudioNode | null = null;
  let closed = false;
  const attach = (n: AudioNode | null) => {
    if (n === from) return;
    if (from) from.disconnect(input);
    from = n;
    if (n) n.connect(input);
  };

  if (source === "mic" || source === "system") {
    openStream(source).then((n) => !closed && attach(n), (err: Error) => !closed && onError(err));
  }

  return {
    read() {
      mono.getByteTimeDomainData(levels.t);
      left.getByteTimeDomainData(levels.l);
      right.getByteTimeDomainData(levels.r);
      return levels;
    },
    close() {
      closed = true;
      attach(null);
      input.disconnect();
      if (source === "mic" || source === "system") closeStream(source);
    },
  };
}
