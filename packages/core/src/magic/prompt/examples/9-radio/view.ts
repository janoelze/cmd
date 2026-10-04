const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const audio = $<HTMLAudioElement>("audio");
const volume = $<HTMLInputElement>("volume");
const bars = [...$("meter").children] as HTMLElement[];

const saved = cmd.state.get<number>("volume");
audio.volume = typeof saved === "number" ? Math.min(1, Math.max(0, saved)) : 0.7;
volume.value = String(audio.volume);

type State = "off" | "connecting" | "live" | "error";
function show(state: State, detail: string) {
  const live = state === "live" || state === "connecting";
  $("app").classList.toggle("on", state === "live");
  $("dot").className = "k-dot " + (state === "live" ? "k-good" : state === "connecting" ? "k-warn" : state === "error" ? "k-bad" : "");
  $("state").textContent = { off: "Off", connecting: "Connecting", live: "Live", error: "Offline" }[state];
  $("detail").textContent = detail;
  $("glyph").dataset.icon = live ? "pause" : "play";
  $("play").setAttribute("aria-label", live ? "Pause" : "Play");
}

// A level meter from the audio itself (the stream allows it: it sends CORS headers).
let analyser: AnalyserNode | null = null;
let levels: Uint8Array<ArrayBuffer> | null = null;
function listen() {
  if (analyser) return;
  try {
    const ctx = new AudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 64;
    ctx.createMediaElementSource(audio).connect(analyser);
    analyser.connect(ctx.destination);
    levels = new Uint8Array(analyser.frequencyBinCount);
    void ctx.resume();
  } catch {
    analyser = null;
  }
}
function frame() {
  requestAnimationFrame(frame);
  const on = analyser && levels && !audio.paused;
  if (on) analyser!.getByteFrequencyData(levels!);
  bars.forEach((b, i) => (b.style.transform = `scaleY(${on ? Math.max(0.15, levels![2 + i * 3]! / 255) : 0.15})`));
}
frame();

$("play").onclick = () => {
  if (!audio.paused) return audio.pause();
  listen();
  show("connecting", "Connecting…");
  audio.load();
  audio.play().catch(() => show("error", "The stream didn't start (media not allowed?)"));
};
$("mute").onclick = () => {
  audio.muted = !audio.muted;
  $("muteIcon").dataset.icon = audio.muted ? "mute" : "volume";
};
volume.oninput = () => {
  audio.volume = Number(volume.value);
  cmd.state.set("volume", audio.volume);
};
audio.onplaying = () => show("live", "Live from bassdrive.com");
audio.onwaiting = () => show("connecting", "Buffering…");
audio.onpause = () => show("off", "Paused");
audio.onerror = () => show("error", "Stream unavailable");
show("off", "Press play to tune in");
