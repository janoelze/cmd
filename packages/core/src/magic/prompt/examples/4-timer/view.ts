type Phase = "Focus" | "Break";
type Timer = { phase: Phase; left: number; end: number | null };

const LEN: Record<Phase, number> = { Focus: 25 * 60, Break: 5 * 60 };
const $ = (id: string) => document.getElementById(id)!;
let t: Timer = cmd.state.get<Timer>("timer") ?? { phase: "Focus", left: LEN.Focus, end: null };
const save = () => cmd.state.set("timer", t);

function tick() {
  if (t.end) {
    t.left = Math.max(0, Math.round((t.end - Date.now()) / 1000));
    if (!t.left) {
      cmd.sound(t.phase === "Focus" ? "Glass" : "Hero");
      t.phase = t.phase === "Focus" ? "Break" : "Focus";
      t = { phase: t.phase, left: LEN[t.phase], end: null };
      save();
    }
  }
  $("clock").textContent = String(Math.floor(t.left / 60)).padStart(2, "0") + ":" + String(t.left % 60).padStart(2, "0");
  $("phase").textContent = t.phase;
  $("go").textContent = t.end ? "Pause" : "Start";
}

$("go").onclick = () => {
  t.end = t.end ? null : Date.now() + t.left * 1000;
  save();
  tick();
};
$("reset").onclick = () => {
  t = { phase: "Focus", left: LEN.Focus, end: null };
  save();
  tick();
};
setInterval(tick, 500);
tick();
