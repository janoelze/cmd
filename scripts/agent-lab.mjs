// Drives coding agents in panes of a cmd core, to test agent activity by hand or
// by script (docs/19-agent-activity-review.md, "The lab loop"). Talks to the core
// of $CMD_HOME (or $CMD_SOCKET); start one from a worktree with `pnpm core`.
//   node scripts/agent-lab.mjs open <cwd> <command>   → pane id (the command runs in the pane's shell)
//   node scripts/agent-lab.mjs type <pane> <text>     types text, then Enter after a pause (a burst reads as a paste)
//   node scripts/agent-lab.mjs keys <pane> <keys>     raw keys: \e Esc, \r Enter, \t, \up \down \left \right, \x7f
//   node scripts/agent-lab.mjs screen <pane> [lines]  what the terminal shows
//   node scripts/agent-lab.mjs wait <pane> <regex> [secs]   until the screen matches (exit 1 on timeout)
//   node scripts/agent-lab.mjs state <pane>           the pane's agent as cmd sees it: state, cause, current turn
//   node scripts/agent-lab.mjs kill <pane>
// <pane> is an id or a prefix.
import net from "node:net";

const sock = process.env.CMD_SOCKET || `${process.env.CMD_HOME}/core.sock`;
const [cmd, a, b, c] = process.argv.slice(2);
let id = 0;
const pending = new Map();
const s = net.createConnection(sock);
let buf = "";
s.setEncoding("utf8");
s.on("data", (d) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
    const m = JSON.parse(buf.slice(0, i));
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  }
});
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    s.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unescape = (t) =>
  t
    .replace(/\\up/g, "\x1b[A")
    .replace(/\\down/g, "\x1b[B")
    .replace(/\\right/g, "\x1b[C")
    .replace(/\\left/g, "\x1b[D")
    .replace(/\\e/g, "\x1b")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
const pane = async (prefix) => (await call("pane.list", {})).find((p) => p.id.startsWith(prefix))?.id ?? prefix;

try {
  if (cmd === "open") {
    const p = await call("pane.create", { cwd: a, command: b });
    console.log(p.id);
  } else if (cmd === "keys") {
    await call("pane.write", { paneId: await pane(a), data: unescape(b) });
  } else if (cmd === "type") {
    const p = await pane(a);
    await call("pane.write", { paneId: p, data: b });
    await sleep(300);
    await call("pane.write", { paneId: p, data: "\r" });
  } else if (cmd === "screen") {
    console.log((await call("pane.read", { paneId: await pane(a), lines: Number(b ?? 40) })).text);
  } else if (cmd === "wait") {
    const p = await pane(a);
    const re = new RegExp(b, "m");
    const until = Date.now() + Number(c ?? 60) * 1000;
    let text = "";
    while (Date.now() < until) {
      text = (await call("pane.read", { paneId: p, lines: 60 })).text;
      if (re.test(text)) break;
      await sleep(700);
    }
    if (!re.test(text)) {
      console.log(`TIMEOUT waiting for /${b}/\n` + text.split("\n").slice(-25).join("\n"));
      process.exitCode = 1;
    } else console.log("matched");
  } else if (cmd === "state") {
    const p = await pane(a);
    const ag = (await call("agent.list", {})).find((x) => x.paneId === p);
    if (!ag) console.log("no agent");
    else {
      const t = ag.turn;
      console.log(`${ag.kind} ${ag.state} (${ag.stateCause ?? "-"}) ${ag.detail ?? ""}`);
      if (t) console.log(`turn #${t.index} ${t.outcome} followUps=${t.followUps?.length ?? 0} tools=${t.tools.map((x) => `${x.name}×${x.count}${x.failed ? `/${x.failed}f` : ""}`).join(",")} files=${t.files.map((f) => `${f.path.split("/").pop()}(${f.via})`).join(",")} ask=${t.ask ? JSON.stringify(t.ask) : "-"} inferred=${JSON.stringify(t.inferred)}`);
    }
  } else if (cmd === "kill") {
    await call("pane.kill", { paneId: await pane(a) });
  }
} finally {
  s.end();
}
