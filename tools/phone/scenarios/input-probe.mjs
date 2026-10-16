// A terminal that says how its input arrived, for checking the phone's compose bar:
// a Return in its own read is how an agent TUI (Claude Code, Codex) takes a prompt;
// text and a Return in one burst is a paste there, and the Return a new line.
// The default scenario's "Input probe" pane runs it.

process.stdin.setRawMode?.(true);
process.stdin.resume();
let typed = "";
// Keys by name, so they show instead of acting: arrows, ESC (alt sends it first), control characters.
const named = (s) =>
  s
    .replace(/\x1b\[([ABCD])/g, (_, c) => ({ A: "↑", B: "↓", C: "→", D: "←" })[c])
    .replace(/\x1b/g, "esc ")
    .replace(/[\x00-\x1f\x7f]/g, (c) => (c === "\x7f" ? "^?" : `^${String.fromCharCode(c.charCodeAt(0) + 64)}`));
const say = (s) => process.stdout.write(`${s}\r\n`);
say("Input probe: send something from the phone.");
process.stdin.on("data", (d) => {
  const s = d.toString("utf8");
  if (s.includes("\x03")) process.exit(0);
  const text = named(s.replace(/\r/g, ""));
  if (s.includes("\r") && text) {
    say(`paste: “${typed + text}” and Return in one burst (an agent adds a new line)`);
    typed = "";
  } else if (s === "\r") {
    say(typed ? `prompt: “${typed}” (Return on its own: an agent sends it)` : "Return on its own");
    typed = "";
  } else {
    typed += text;
    say(`text: “${text}” (waiting for Return)`);
  }
});
