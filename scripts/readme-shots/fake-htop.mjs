// A stand-in for htop in README screenshots: one fixed, plausible frame (8 cores,
// the processes of the staged scene), so shots are repeatable and don't show the
// real machine's processes. Redraws on resize. usage: htop (via the bin/ shim)

const ESC = "\x1b[";
const sgr = (code, s) => `${ESC}${code}m${s}${ESC}0m`;
const len = (s) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
const fit = (s, w) => (s.length > w ? s.slice(0, w) : s.padEnd(w));

// [user %, system %] per core
const CORES = [[38, 9], [22, 6], [61, 12], [14, 4], [47, 8], [9, 3], [72, 10], [27, 5]];

function bar(label, parts, text, w) {
  const inner = w - label.length - 2;
  const cells = [];
  for (const [pct, color] of parts) for (let i = 0; i < Math.round((pct / 100) * inner); i++) cells.push(sgr(color, "|"));
  const tail = text.slice(0, inner);
  const room = inner - tail.length;
  const shown = cells.slice(0, room);
  return `${sgr("36", label)}${sgr("1", "[")}${shown.join("")}${" ".repeat(room - shown.length)}${sgr("90", tail)}${sgr("1", "]")}`;
}

const cpu = (i, w) => {
  const [u, s] = CORES[i];
  return bar(String(i).padStart(3), [[u, "32"], [s, "31"]], `${(u + s).toFixed(1)}%`, w);
};
const info = (k, v) => `${sgr("36", k)} ${sgr("1", v)}`;

// pid, user, pri, ni, virt, res, state, cpu, mem, time, command
const PROCS = [
  [48213, "dev", 24, 0, "412G", "842M", "R", 48.2, 2.3, "3:12.44", "claude --demo=working"],
  [48370, "dev", 17, 0, "1.6G", "311M", "S", 21.7, 0.8, "0:41.09", "node packages/core/src/main.ts"],
  [48529, "dev", 24, 0, "411G", "655M", "R", 17.3, 1.8, "1:58.71", "claude --demo=ask"],
  [49102, "dev", 24, 0, "1.2G", "268M", "R", 14.9, 0.7, "0:06.38", "node vitest/dist/workers/forks.js"],
  [48371, "dev", 17, 0, "1.4G", "402M", "S", 9.6, 1.1, "2:04.15", "Electron Helper (Renderer)"],
  [49110, "dev", 24, 0, "622M", "98M", "R", 7.2, 0.3, "0:01.92", "esbuild --service=0.25.9 --ping"],
  [48688, "dev", 17, 0, "410G", "590M", "S", 4.1, 1.6, "4:47.30", "claude --demo=done"],
  [48366, "dev", 17, 0, "1.9G", "236M", "S", 3.3, 0.6, "1:12.66", "Electron"],
  [48372, "dev", 17, 0, "433M", "71M", "S", 2.8, 0.2, "0:19.03", "Electron Helper (GPU)"],
  [48390, "dev", 17, 0, "34M", "5.1M", "S", 1.4, 0.0, "0:02.71", "procinfo"],
  [49055, "dev", 17, 0, "48M", "9.8M", "S", 0.9, 0.0, "0:00.41", "git status --porcelain"],
  [48214, "dev", 17, 0, "37M", "6.2M", "S", 0.4, 0.0, "0:00.33", "zsh"],
  [48530, "dev", 17, 0, "37M", "6.0M", "S", 0.3, 0.0, "0:00.29", "zsh"],
  [48689, "dev", 17, 0, "37M", "6.1M", "S", 0.2, 0.0, "0:00.27", "zsh"],
  [312, "root", 4, 0, "412M", "18M", "S", 0.2, 0.0, "11:03.88", "WindowServer"],
  [48931, "dev", 17, 0, "37M", "6.4M", "S", 0.1, 0.0, "0:00.18", "zsh"],
  [702, "dev", 17, 0, "412M", "22M", "S", 0.1, 0.1, "0:42.10", "mdworker_shared"],
  [1, "root", 17, 0, "34M", "12M", "S", 0.0, 0.0, "2:18.47", "launchd"],
];

/** Cut a line with escape codes to `w` visible columns. */
function clip(s, w) {
  let out = "";
  let n = 0;
  for (const m of s.matchAll(/(\x1b\[[0-9;]*m)|(.)/gsu)) {
    if (m[1]) out += m[1];
    else if (n < w) (out += m[2]), n++;
  }
  return out + `${ESC}0m`;
}

function draw() {
  const w = Math.max(40, process.stdout.columns || 80);
  const h = Math.max(12, process.stdout.rows || 24);
  const col = Math.floor((w - 1) / 2);
  const mem = (w) => bar("Mem", [[38, "32"], [9, "34"], [12, "33"]], "21.4G/36.0G", w);
  const swp = (w) => bar("Swp", [[5, "31"]], "112M/2.00G", w);
  const tasks = info("Tasks:", `412, 1873 thr; ${sgr("32", "4 running")}`);
  const load = info("Load average:", "3.12 2.84 2.51");
  const up = info("Uptime:", "4 days, 07:12:44");
  // Wide: htop's two-column header. Narrow: cores in pairs, the rest one per line.
  const left = w >= 90 ? [cpu(0, col), cpu(1, col), cpu(2, col), cpu(3, col), mem(col), swp(col)] : [0, 1, 2, 3].map((i) => cpu(i, col));
  const right = w >= 90 ? [cpu(4, col), cpu(5, col), cpu(6, col), cpu(7, col), tasks, load, up] : [4, 5, 6, 7].map((i) => cpu(i, col));
  const lines = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? "";
    lines.push(l + " ".repeat(Math.max(1, col - len(l) + 1)) + (right[i] ?? ""));
  }
  if (w < 90) lines.push(mem(w - 1), swp(w - 1), tasks, load, up);
  lines.push("");
  // Narrow windows drop PRI, NI and VIRT, as you would in htop's setup for a small pane.
  const wide = w >= 90;
  const head = wide
    ? "    PID USER   PRI  NI  VIRT   RES S  CPU% MEM%    TIME+  Command"
    : "    PID USER    RES S  CPU% MEM%    TIME+  Command";
  lines.push(sgr("30;42", fit(head, w)));
  const rows = h - lines.length - 1;
  PROCS.slice(0, rows).forEach(([pid, user, pri, ni, virt, res, st, c, m, time, cmd], i) => {
    const pre =
      `${String(pid).padStart(7)} ${user.padEnd(5)} ` +
      (wide ? `${String(pri).padStart(3)} ${String(ni).padStart(3)} ${virt.padStart(5)} ` : "") +
      `${res.padStart(5)} ${st} ${c.toFixed(1).padStart(5)} ${m.toFixed(1).padStart(4)} ${time.padStart(8)}  `;
    const room = Math.max(0, w - pre.length);
    if (i === 0) return lines.push(sgr("30;46", fit(pre + cmd, w)));
    // htop shows the program name bold, its arguments plain.
    const plain = cmd.slice(0, room);
    const exe = cmd.startsWith("Electron") || !cmd.includes(" ") ? cmd.length : cmd.indexOf(" ");
    const body = sgr(cmd.startsWith("claude") ? "1;36" : "1", plain.slice(0, exe)) + plain.slice(exe);
    lines.push(`${user === "root" ? sgr("90", pre) : st === "R" ? pre.replace(/ R /, sgr("32", " R ")) : pre}${body}`);
  });
  while (lines.length < h - 1) lines.push("");
  const keys = [["F1", "Help"], ["F2", "Setup"], ["F3", "Search"], ["F4", "Filter"], ["F5", "Tree"], ["F6", "SortBy"], ["F7", "Nice -"], ["F8", "Nice +"], ["F9", "Kill"], ["F10", "Quit"]];
  let foot = "";
  let used = 0;
  for (const [k, label] of keys) {
    if (used + k.length + 6 > w) break;
    foot += k + sgr("30;46", label.padEnd(6));
    used += k.length + 6;
  }
  lines.push(foot + sgr("30;46", " ".repeat(Math.max(0, w - used))));
  process.stdout.write(`${ESC}?25l${ESC}H${ESC}2J` + lines.map((l) => clip(l, w)).join("\r\n"));
}

process.title = "htop"; // what cmd shows as the terminal's process
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (d) => (d.includes(3) || d.includes(113)) && process.exit(0)); // ⌃C, q
process.stdout.on("resize", draw);
process.on("exit", () => process.stdout.write(`${ESC}?25h${ESC}H${ESC}2J`));
draw();
