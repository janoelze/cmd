// cmd's tools from outside the core (docs/54, The surfaces): `cmd tools` lists them, `cmd tool`
// runs one, and `cmd mcp` serves them as an MCP server over stdio, the one an agent's config
// starts. All three read the core's registry (tools.list, tools.call) and define no tool of their
// own. The caller is this process's pane: CMD_PANE_ID and CMD_PANE_TOKEN when the agent passed
// them on, else the core finds the pane from this process's ancestors (read-only then).

import { execFileSync } from "node:child_process";
import { ENV, type ToolCaller, type ToolInfo } from "@cmd/protocol";
import { connect, type Connection } from "@cmd/protocol/node";

export const TOOLS_HELP = `  tools [--json]                      cmd's tools for agents (as cmd mcp serves them)
  tool NAME ['JSON' | -]              run one as this pane's agent; its input as JSON (- reads stdin)
  mcp                                 cmd's tools as an MCP server over stdio (for agent configs)`;

/** This process and its ancestors, nearest first: how the core finds the pane when the env didn't come along. */
function ancestors(): number[] {
  try {
    const parent = new Map<number, number>();
    for (const line of execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 2000 }).split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid && ppid !== undefined) parent.set(pid, ppid);
    }
    const out: number[] = [];
    for (let p = process.pid; p > 1 && out.length < 32; p = parent.get(p) ?? 0) out.push(p);
    return out;
  } catch {
    return [process.pid];
  }
}

function caller(): ToolCaller {
  const env = process.env;
  return { paneId: env[ENV.paneId] || null, token: env.CMD_PANE_TOKEN || null, pids: ancestors() };
}

export async function toolsCommand(cmd: string, args: string[]): Promise<number> {
  if (cmd === "mcp") return mcp();
  let conn: Connection;
  try {
    conn = await connect(undefined, { hello: false });
  } catch {
    console.error("cmd: no core running here: cmd's tools work in cmd's terminals");
    return 2;
  }
  try {
    const who = caller();
    if (cmd === "tools") {
      const { tools, paneId } = await conn.client.call("tools.list", who);
      if (args.includes("--json")) return console.log(JSON.stringify(tools, null, 2)), 0;
      if (!paneId) return console.error("cmd: no tools here: they work in cmd's terminals, with Agent integration on (Settings → Agents)"), 4;
      for (const t of tools) console.log(`${t.name.padEnd(9)} ${t.acts ? "acts " : "reads"}  ${t.description}\n`);
      console.log("Run one: cmd tool NAME '{\"why\": \"…\", …}' (cmd tools --json for each input's schema)");
      return 0;
    }
    const [name, json = "{}"] = args;
    if (!name) return console.error("usage: cmd tool NAME ['JSON' | -]"), 2;
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(json === "-" ? await stdin() : json) as Record<string, unknown>;
    } catch (e) {
      return console.error(`cmd: the input isn't JSON: ${(e as Error).message}`), 2;
    }
    const r = await conn.client.call("tools.call", { ...who, name, input: { why: `cmd tool ${name}`, ...input } });
    (r.isError ? console.error : console.log)(r.output);
    return r.isError ? 1 : 0;
  } finally {
    conn.close();
  }
}

async function stdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// ── cmd mcp ──────────────────────────────────────────────

/** tools.list when the core can't be reached: no tools, nothing to say. */
const NONE = { paneId: null, tools: [] as ToolInfo[], instructions: "" };

/** MCP versions this server speaks, newest first; it answers in the client's when it knows it. */
const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface Message {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** MCP's view of a tool: hints from cmd's access table (clients treat them as hints; cmd enforces its own). */
export const mcpTool = (t: ToolInfo) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: { readOnlyHint: t.readOnly, destructiveHint: t.destructive, openWorldHint: false },
});

/**
 * The server: newline-delimited JSON-RPC on stdin and stdout (MCP's stdio transport), each request
 * answered from the core. Outside cmd, or with Agent integration off, it lists no tools and says
 * nothing. Ends when the agent closes stdin.
 */
async function mcp(): Promise<number> {
  const who = caller();
  let conn: Promise<Connection> | null = null;
  const core = () => (conn ??= connect(undefined, { hello: false }).then((c) => (void c.closed.then(() => (conn = null)), c)));
  const ask = async <T,>(fn: (c: Connection) => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn(await core());
    } catch {
      conn = null;
      return fallback;
    }
  };
  const send = (m: object) => process.stdout.write(JSON.stringify(m) + "\n");
  const answer = async (m: Message): Promise<unknown> => {
    switch (m.method) {
      case "initialize": {
        const asked = String(m.params?.protocolVersion ?? "");
        const { instructions } = await ask((c) => c.client.call("tools.list", who), NONE);
        return { protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "cmd", version: "1" }, ...(instructions ? { instructions } : {}) };
      }
      case "ping":
        return {};
      case "tools/list": {
        const { tools } = await ask((c) => c.client.call("tools.list", who), NONE);
        return { tools: tools.map(mcpTool) };
      }
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        const input = (m.params?.arguments ?? {}) as Record<string, unknown>;
        const r = await ask((c) => c.client.call("tools.call", { ...who, name, input }), { output: "cmd isn't reachable from here: its tools work in cmd's terminals.", isError: true });
        return { content: [{ type: "text", text: r.output }], isError: r.isError };
      }
      default:
        throw Object.assign(new Error(`no method ${m.method}`), { code: -32601 });
    }
  };
  let buf = "";
  const pending = new Set<Promise<unknown>>();
  for await (const chunk of process.stdin) {
    buf += (chunk as Buffer).toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m: Message;
      try {
        m = JSON.parse(line) as Message;
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } });
        continue;
      }
      // Notifications (initialized, cancelled) need no answer.
      if (m.id === undefined || m.id === null || !m.method) continue;
      const id = m.id;
      // Calls run side by side: a tool waiting for the person doesn't hold up a ping.
      const p = answer(m).then(
        (result) => send({ jsonrpc: "2.0", id, result }),
        (e: Error & { code?: number }) => send({ jsonrpc: "2.0", id, error: { code: e.code ?? -32603, message: e.message } }),
      );
      pending.add(p);
      void p.finally(() => pending.delete(p));
    }
  }
  await Promise.all(pending);
  if (conn) (await (conn as Promise<Connection>).catch(() => null))?.close();
  return 0;
}
