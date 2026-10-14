// A stand-in for a coding agent's terminal UI (Claude Code, Codex: Ink-style), for the
// perf harnesses (latency.mjs --agents): what such an agent writes while it works, at
// about its rates. Every 80 ms it redraws its live region in place (cursor up, erase
// each line, write it again): streamed text, a spinner with elapsed time and tokens,
// the input box. Its title spins too (OSC 0). Every ~400 ms finished output (a tool's
// result, a paragraph) is committed above the region and scrolls up for good.
// usage: node e2e/fake-agent.mjs [--seconds N]   (runs until killed, or N seconds)

const ESC = "\x1b";
const SPIN = ["·", "✢", "✳", "✶", "✻", "✽"];
const TITLE_SPIN = ["⠂", "⠐"];
const WORDS = "the renderer measures each row before the commit so the glide starts where the row was shown and the core answers first then reads the log in slices while the window paints".split(" ");
const seconds = process.argv.includes("--seconds") ? Number(process.argv[process.argv.indexOf("--seconds") + 1]) : Infinity;

const cols = () => Math.max(40, process.stdout.columns || 100);
let height = 0; // lines of the live region on screen now
let tick = 0;
let streamed = [];
const started = Date.now();

const dim = (s) => `${ESC}[2m${s}${ESC}[22m`;
const color = (n, s) => `${ESC}[38;5;${n}m${s}${ESC}[39m`;
const word = (i) => WORDS[(i * 7 + tick) % WORDS.length];
const sentence = (n, seed) => Array.from({ length: n }, (_, i) => word(seed + i)).join(" ");
const fit = (s, w) => (s.length > w ? s.slice(0, w) : s);

/** The live region: what the agent shows while it works, redrawn in place. */
function region() {
  const w = cols();
  const secs = Math.floor((Date.now() - started) / 1000);
  const box = w - 2;
  return [
    ...streamed.slice(-6).map((l) => fit(l, w)),
    "",
    `${color(208, SPIN[tick % SPIN.length])} ${color(208, "Thinking…")} ${dim(`(${secs}s · ↑ ${(1.2 + tick / 100).toFixed(1)}k tokens · esc to interrupt)`)}`,
    "",
    dim(`╭${"─".repeat(box)}╮`),
    `${dim("│")} > ${" ".repeat(box - 3)}${dim("│")}`,
    dim(`╰${"─".repeat(box)}╯`),
    dim(fit("  ⏵⏵ accept edits on (shift+tab to cycle)", w)),
  ];
}

/** Erase the region (cursor up over it, each line cleared), then draw `lines` above a new one. */
function frame(committed = []) {
  let out = "";
  for (let i = 0; i < height; i++) out += `${ESC}[2K${ESC}[1A`;
  if (height) out += `${ESC}[2K${ESC}[G`;
  for (const l of committed) out += `${l}\r\n`;
  const r = region();
  out += r.join("\r\n") + "\r\n";
  height = r.length;
  out += `${ESC}]0;${TITLE_SPIN[tick % 2]} Working on the renderer${String.fromCharCode(7)}`;
  process.stdout.write(out);
}

/** Finished output, as an agent commits it: a tool call and its result, or a paragraph. */
function committed() {
  const w = cols();
  if (tick % 3 === 0) {
    const n = 4 + (tick % 9);
    return [
      `${color(114, "⏺")} ${color(252, "Bash")}(${dim("pnpm vitest run packages/ui")})`,
      ...Array.from({ length: n }, (_, i) => `  ${dim("⎿")}  ${fit(`${color(i % 2 ? 114 : 245, i % 2 ? "✓" : "·")} test/${word(i)}.test.ts (${(i * 37) % 90} tests) ${(i * 13) % 400}ms`, w - 6)}`),
      "",
    ];
  }
  return [`${color(252, "⏺")} ${fit(sentence(14, tick), w - 2)}`, `  ${fit(sentence(16, tick + 3), w - 2)}`, ""];
}

process.stdout.write(`${ESC}[?25l`); // the cursor hidden, as Ink does
const timer = setInterval(() => {
  tick++;
  streamed.push(sentence(8 + (tick % 6), tick));
  if (streamed.length > 12) streamed = streamed.slice(-12);
  frame(tick % 5 === 0 ? committed() : []);
  if ((Date.now() - started) / 1000 > seconds) stop();
}, 80);

function stop() {
  clearInterval(timer);
  process.stdout.write(`${ESC}[?25h\r\n`);
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
