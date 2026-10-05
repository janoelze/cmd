// The slow half of cmd's agent hook (hooks.ts). The hook script runs this only for
// SessionStart and prompts, and only while peer briefings are on: it sends the
// event to the core (hook.ingest) and prints the context the core returns, in the
// shape Claude, Codex and Gemini read. Only node:net, so it starts fast. Never
// fails the agent: always exits 0, within 2 s.
//
// Usage: node hook-main.ts <kind> <event> <pane id>, the hook payload on stdin.

import net from "node:net";

const [kind = "", event = "", paneId = ""] = process.argv.slice(2);

function done(context: unknown): never {
  if (typeof context === "string" && context) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }) + "\n");
  } else if (kind === "gemini") {
    process.stdout.write("{}\n"); // Gemini wants JSON on stdout
  }
  process.exit(0);
}

setTimeout(() => done(null), 2000);

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
let payload: unknown;
try {
  payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  done(null);
}

const sock = net.createConnection(process.env.CMD_SOCKET ?? "");
sock.on("error", () => done(null));
sock.on("close", () => done(null));
sock.setEncoding("utf8");
let buf = "";
sock.on("data", (d: string) => {
  buf += d;
  for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
    try {
      const msg = JSON.parse(buf.slice(0, i));
      if (msg.id === 1) done(msg.result?.context);
    } catch {}
  }
});
sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hook.ingest", params: { paneId, agent: kind, event, payload } }) + "\n");
