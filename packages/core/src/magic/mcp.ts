// `cmd magic mcp`: a minimal MCP server on stdio that offers the Magic tools to
// a CLI agent (claude -p, codex exec) and relays every call over a Unix socket
// to the process running the Magic agent, which executes it (backends.ts).
// It never runs anything itself.

import net from "node:net";
import readline from "node:readline";
import { RELAY_ENV, RELAY_TOOLS_ENV } from "./backends.ts";
import { TOOL_SPECS } from "./tools.ts";

export async function serveMcp(): Promise<void> {
  const sock = process.env[RELAY_ENV];
  if (!sock) throw new Error(`${RELAY_ENV} is not set`);
  const names = new Set((process.env[RELAY_TOOLS_ENV] ?? "").split(",").filter(Boolean));
  const specs = TOOL_SPECS.filter((t) => names.has(t.name));

  const relay = net.connect(sock);
  await new Promise<void>((res, rej) => relay.once("connect", res).once("error", rej));
  const pending = new Map<number, (r: { output: string; isError: boolean }) => void>();
  let nextId = 1;
  let rbuf = "";
  relay.on("data", (d) => {
    rbuf += d.toString("utf8");
    let nl: number;
    while ((nl = rbuf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(rbuf.slice(0, nl));
      rbuf = rbuf.slice(nl + 1);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  relay.on("close", () => process.exit(0));
  const call = (name: string, input: unknown) =>
    new Promise<{ output: string; isError: boolean }>((res) => {
      const id = nextId++;
      pending.set(id, res);
      relay.write(JSON.stringify({ id, name, input }) + "\n");
    });

  const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id: req.id, result });
    switch (req.method) {
      case "initialize":
        reply({
          protocolVersion: (req.params?.protocolVersion as string) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "cmd-magic", version: "0.1.0" },
        });
        break;
      case "ping":
        reply({});
        break;
      case "tools/list":
        reply({ tools: specs.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema })) });
        break;
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        // Answer asynchronously: calls may run in parallel.
        void call(name, req.params?.arguments ?? {}).then((r) => reply({ content: [{ type: "text", text: r.output }], isError: r.isError }));
        break;
      }
      default:
        if (req.id !== undefined) send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `unknown method ${req.method}` } });
    }
  }
}
