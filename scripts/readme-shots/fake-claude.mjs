// A stand-in for Claude Code in README screenshots: draws one fixed, plausible
// session per scenario and stays in the foreground, so cmd detects it as
// `claude`. The matching hook events (which drive the sidebar state) are sent by
// screenshots.mjs, from SCENARIOS[name].hooks. Uses only the 16 ANSI colours, so
// the screenshot shows the active terminal theme.
// usage: claude --demo=<scenario>

const ESC = "\x1b[";
const c = (code) => (s) => `${ESC}${code}m${s}${ESC}0m`;
const dim = c("2");
const bold = c("1");
const red = c("31");
const green = c("32");
const yellow = c("33");
const blue = c("34");
const magenta = c("35");
const gray = c("90");
const orange = c("91"); // bright red reads as Claude's orange in most themes

const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const pad = (s, w) => s + " ".repeat(Math.max(0, w - [...visible(s)].length));

/** Wrap plain text to `w` columns, prefixing continuation lines with `indent`. */
function wrap(text, w, first = "", indent = "") {
  const out = [];
  let line = first;
  for (const word of text.split(" ")) {
    if ([...visible(line)].length + word.length + 1 > w && visible(line).trim()) {
      out.push(line);
      line = indent;
    }
    line += (visible(line).trim() ? " " : "") + word;
  }
  out.push(line);
  return out;
}

function box(lines, w, color = gray) {
  const inner = w - 4;
  return [
    color(`╭${"─".repeat(w - 2)}╮`),
    ...lines.map((l) => `${color("│")} ${pad(l, inner)} ${color("│")}`),
    color(`╰${"─".repeat(w - 2)}╯`),
  ];
}

// Blocks of the transcript; each renders to lines at a given width.
const prompt = (text) => (w) => wrap(text, w - 2, gray(">"), "  ").map(gray);
const say = (text) => (w) => wrap(text, w - 2, "⏺", "  ");
const tool = (name, arg, result) => (w) => [
  `${green("⏺")} ${bold(name)}(${arg})`,
  ...result.split("\n").flatMap((r, i) => wrap(r, w - 2, i ? "    " : "  ⎿ ", "     ")).map(gray),
];
const diff = (lines) => (w) =>
  lines.map(([n, op, line]) => {
    const text = line.length > w - 10 ? line.slice(0, w - 11) + "…" : line; // cut, don't wrap, like a diff view
    const num = gray(String(n).padStart(6));
    if (op === "+") return `${num} ${green("+")} ${green(text)}`;
    if (op === "-") return `${num} ${red("-")} ${red(text)}`;
    return `${num}   ${dim(text)}`;
  });
const tree = (items) => () =>
  items.map(([label, info, done], i) => {
    const branch = gray(i === items.length - 1 ? "  └─ " : "  ├─ ");
    return `${branch}${done ? green("✓") : yellow("◐")} ${label} ${gray(`· ${info}`)}`;
  });
const blank = () => () => [""];
const spinner = (verb, info) => () => [`${orange("✻")} ${orange(verb + "…")} ${gray(`(${info} · esc to interrupt)`)}`];

const input = (w) => [...box([`${gray(">")} `], w), gray("  ? for shortcuts")];

export const SCENARIOS = {
  working: {
    title: "Canvas minimap drag",
    session: "demo-working",
    prompt: "make the canvas minimap draggable, and keep the camera inside the world bounds while dragging",
    blocks: [
      say("I'll look at how the minimap is drawn and how the camera moves today."),
      blank(),
      tool("Read", "apps/desktop/src/renderer/src/canvas.ts", "Read 214 lines"),
      blank(),
      tool("Agent", "Explore", "2 agents running"),
      tree([
        ["Find minimap pointer handling", "9 tool uses · 18.2k tokens", true],
        ["Trace camera clamping", "4 tool uses · 7.9k tokens", false],
      ]),
      blank(),
      say("The minimap already maps clicks to world points, so dragging can reuse it. Clamping belongs in canvas.ts next to frame()."),
      blank(),
      tool("Update", "apps/desktop/src/renderer/src/canvas.ts", "Updated canvas.ts with 9 additions and 2 removals"),
      diff([
        [146, " ", "/** The smallest camera move that shows `r`. */"],
        [147, "-", "export function reveal(r: Rect, vp: Viewport, cam: Camera) {"],
        [147, "+", "export function clampCamera(cam: Camera, world: Rect, vp: Viewport): Camera {"],
        [148, "+", "  const w = vp.w / cam.zoom, h = vp.h / cam.zoom;"],
        [149, "+", "  const x = Math.min(Math.max(cam.x, world.x - w / 2), world.x + world.w - w / 2);"],
        [150, "+", "  const y = Math.min(Math.max(cam.y, world.y - h / 2), world.y + world.h - h / 2);"],
        [151, "+", "  return { ...cam, x, y };"],
      ]),
      blank(),
      spinner("Wiring up the drag", "41s · ↓ 3.2k tokens"),
    ],
    hooks: (cwd) => [
      ["SessionStart", { cwd }],
      ["UserPromptSubmit", { prompt: SCENARIOS.working.prompt }],
      ["SubagentStart", { agent_id: "demo-sub-1", agent_type: "Explore" }],
      ["SubagentStart", { agent_id: "demo-sub-2", agent_type: "Explore" }],
      ["SubagentStop", { agent_id: "demo-sub-1", last_assistant_message: "Pointer handling lives in WindowsView.tsx (Minimap)." }],
      ["PreToolUse", { tool_name: "Edit", tool_input: { file_path: `${cwd}/apps/desktop/src/renderer/src/canvas.ts` } }],
    ],
  },
  ask: {
    title: "Flaky reconnect test",
    session: "demo-ask",
    prompt: "the preload reconnect test fails about one run in ten, find out why and fix it",
    blocks: [
      tool("Grep", '"reconnect"', "Found 7 matches in 3 files"),
      blank(),
      tool("Read", "apps/desktop/src/preload/index.ts", "Read 168 lines"),
      blank(),
      say("The test waits a fixed 200 ms for the socket to come back, but the backoff starts at 250 ms. It passes only when the first retry lands early. I'll wait for the reconnect event instead."),
      blank(),
      tool("Update", "apps/desktop/test/reconnect.test.ts", "Updated reconnect.test.ts with 2 additions and 1 removal"),
      diff([
        [41, " ", "  core.restart();"],
        [42, "-", "  await sleep(200);"],
        [42, "+", "  await once(bridge, \"reconnected\");"],
        [43, " ", "  expect(await bridge.call(\"core.hello\", {})).toBeTruthy();"],
      ]),
      blank(),
      say("Now I'll run it 50 times in a row to be sure."),
    ],
    footer: (w) =>
      box(
        [
          bold("Bash command"),
          "",
          "  for i in {1..50}; do pnpm vitest run reconnect || break; done",
          gray("  Run the reconnect test 50 times"),
          "",
          "Do you want to proceed?",
          `${blue("❯")} ${blue("1. Yes")}`,
          "  2. Yes, and don't ask again for pnpm vitest commands in ~/src/cmd",
          `  3. No, and tell Claude what to do differently ${gray("(esc)")}`,
        ].map((l) => ([...visible(l)].length > w - 4 ? l.slice(0, w - 5) + "…" : l)),
        w,
        yellow,
      ),
    hooks: (cwd) => [
      ["SessionStart", { cwd }],
      ["UserPromptSubmit", { prompt: SCENARIOS.ask.prompt }],
      ["PreToolUse", { tool_name: "Bash", tool_input: { command: "pnpm vitest run", description: "Run the reconnect test 50 times" } }],
      ["PermissionRequest", { tool_name: "Bash", message: "Run the reconnect test 50 times?" }],
    ],
  },
  done: {
    title: "Recent sessions in sidebar",
    session: "demo-done",
    prompt: "show the five most recent past sessions under the open windows in the sidebar",
    blocks: [
      tool("Read", "packages/core/src/search/index.ts", "Read 290 lines"),
      tool("Update", "packages/protocol/src/rpc.ts", "Updated rpc.ts with 2 additions"),
      tool("Update", "packages/core/src/core.ts", "Updated core.ts with 1 addition"),
      tool("Write", "apps/desktop/src/renderer/src/components/SidebarRows.tsx", "Wrote 84 lines"),
      tool("Bash", "pnpm typecheck && pnpm test", "Test Files  41 passed (41)\n Tests  386 passed (386)"),
      blank(),
      say("Done. The sidebar now ends with a Recent section:"),
      blank(),
      (w) => [
        ...wrap("• search.recent returns the newest sessions from the index, skipping ones open in a terminal", w - 4, "  ", "    "),
        ...wrap("• Rows show the session title and how long ago it ran; Enter resumes it in a new terminal", w - 4, "  ", "    "),
        ...wrap("• Tests and typecheck pass", w - 4, "  ", "    "),
      ],
      blank(),
      () => [gray("✻ Worked for 3m 12s")],
    ],
    hooks: (cwd) => [
      ["SessionStart", { cwd }],
      ["UserPromptSubmit", { prompt: SCENARIOS.done.prompt }],
      ["Stop", { last_assistant_message: "Done. The sidebar now ends with a Recent section." }],
    ],
  },
};

function draw(s) {
  const w = Math.max(30, process.stdout.columns || 80);
  const h = Math.max(10, process.stdout.rows || 24);
  const header = box([`${orange("✻")} Welcome to ${bold("Claude Code")}!`, "", gray(`  cwd: ${process.cwd().replace(/^\/Users\/[^/]+/, "~")}`)], Math.min(w, 52), orange);
  const body = [prompt(s.prompt), blank(), ...s.blocks].flatMap((b) => b(w));
  const foot = ["", ...(s.footer ? s.footer(w) : input(w))];
  let lines = [...header, "", ...body];
  const room = h - foot.length;
  // Too tall: drop from the top, like a scrolled terminal.
  if (lines.length > room) lines = lines.slice(lines.length - room);
  while (lines.length < room) lines.push("");
  process.stdout.write(`\x1b]0;✳ ${s.title}\x07${ESC}?25l${ESC}H${ESC}2J` + [...lines, ...foot].join("\r\n"));
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/claude");
if (isMain) {
  const name = (process.argv.find((a) => a.startsWith("--demo=")) ?? "--demo=working").slice(7);
  const s = SCENARIOS[name] ?? SCENARIOS.working;
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", (d) => d.includes(3) && process.exit(0)); // ⌃C
  process.stdout.on("resize", () => draw(s));
  process.on("exit", () => process.stdout.write(`${ESC}?25h`));
  draw(s);
}
