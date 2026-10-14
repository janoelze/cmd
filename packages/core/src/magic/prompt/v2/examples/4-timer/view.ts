type Phase = "Focus" | "Break";
type Timer = { phase: Phase; focus: number; left: number; end: number | null; done: { day: string; n: number } };

const $ = (id: string) => document.getElementById(id)!;
const today = () => new Date().toDateString();
const BREAK = 5 * 60;
let t: Timer = cmd.state.get<Timer>("timer") ?? { phase: "Focus", focus: 25 * 60, left: 25 * 60, end: null, done: { day: today(), n: 0 } };
const save = () => cmd.state.set("timer", t);
const length = () => (t.phase === "Focus" ? t.focus : BREAK);

function tick() {
  if (t.end) {
    t.left = Math.max(0, Math.round((t.end - Date.now()) / 1000));
    if (!t.left) {
      cmd.sound(t.phase === "Focus" ? "Glass" : "Hero");
      if (t.phase === "Focus") t.done = { day: today(), n: (t.done.day === today() ? t.done.n : 0) + 1 };
      t.phase = t.phase === "Focus" ? "Break" : "Focus";
      t.left = length();
      t.end = null;
      save();
    }
  }
  $("clock").textContent = String(Math.floor(t.left / 60)).padStart(2, "0") + ":" + String(t.left % 60).padStart(2, "0");
  $("phase").textContent = t.phase;
  $("dot").className = "k-dot " + (t.end ? (t.phase === "Focus" ? "k-good" : "k-warn") : "");
  $("progress").style.setProperty("--v", `${100 - (t.left / length()) * 100}%`);
  $("goIcon").dataset.icon = t.end ? "pause" : "play";
  $("goLabel").textContent = t.end ? "Pause" : t.left < length() ? "Resume" : "Start";
  const n = t.done.day === today() ? t.done.n : 0;
  $("today").textContent = n ? `${n} done today` : "";
  for (const b of $("lengths").querySelectorAll("button")) b.setAttribute("aria-pressed", String(Number(b.dataset.min) * 60 === t.focus));
}

$("go").onclick = () => {
  t.end = t.end ? null : Date.now() + t.left * 1000;
  save();
  tick();
};
$("reset").onclick = () => {
  t = { ...t, phase: "Focus", left: t.focus, end: null };
  save();
  tick();
};
$("lengths").onclick = (e) => {
  const min = Number((e.target as HTMLElement).dataset.min);
  if (!min) return;
  t = { ...t, focus: min * 60, phase: "Focus", left: min * 60, end: null };
  save();
  tick();
};
setInterval(tick, 500);
tick();
