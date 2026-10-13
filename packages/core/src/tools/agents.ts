// The tools for agents and terminals: start or stop a coding agent, wait for agents or a
// terminal, and type into one (text or keys), which always asks first and refuses what the
// deny-list names.

import path from "node:path";
import type { Agent, AppWindow } from "@cmd/protocol";
import { agentLine, untrusted } from "./board.ts";
import { denied } from "./deny.ts";
import { agentIn, num, otherWindow, readablePath, ref, schema, str, windowName, windowOf, type ToolContext, type Tool } from "./kit.ts";

/** How long starting an agent waits for it to get going (or stop at a question). */
const START_WAIT_MS = 15_000;

const agentTool: Tool = {
  acts: true,
  calls: ["window.list", "pane.list", "agent.list", "agent.spawn", "agent.wait", "pane.read", "agent.kill"],
  spec: {
    name: "agent",
    explores: false,
    description:
      "Start a coding agent with a task, or stop one. `start` opens a terminal with the agent (claude by default) working on `prompt` in the workspace's folder; write the prompt as a complete brief (what, where, how to check it's done). `stop` asks the person first. An agent you started reports back by itself when it is done, fails or needs input, so you needn't poll it. Read it to see what it said.",
    schema: schema({ do: { type: "string", enum: ["start", "stop"] }, prompt: { type: "string" }, kind: { type: "string", enum: ["claude", "codex"] }, folder: { type: "string", description: "Where it works, relative to the workspace's folder (default: the workspace's folder)." }, ref }, ["do"]),
  },
  target: (i, b) => (i.do === "stop" && i.ref ? b.refs.id(i.ref) : null),
  async confirm(i, b) {
    if (i.do !== "stop") return null;
    const w = await windowOf(b, i.ref);
    const a = await agentIn(b, w);
    if (!a) throw new Error(`${String(i.ref)} has no agent`);
    return { title: `Stop ${a.kind}${a.name ? ` “${a.name}”` : ""} in ${windowName(w)}`, exact: agentLine(a), rule: { key: "agent.stop", label: "stopping agents" } };
  },
  async run(i, b) {
    if (i.do === "stop") {
      const a = await agentIn(b, await windowOf(b, i.ref));
      if (!a) throw new Error(`${String(i.ref)} has no agent`);
      await b.call("agent.kill", { agentId: a.id });
      return `Stopped the agent in ${String(i.ref)}.`;
    }
    const prompt = str(i.prompt)?.trim();
    if (!prompt) throw new Error("start needs a prompt");
    const cwd = str(i.folder) ? readablePath(b, str(i.folder)!) : b.workspace().root;
    // An agent's agent is its child (the sidebar shows it under its caller).
    const a = await b.call("agent.spawn", { kind: str(i.kind) ?? "claude", prompt, workspaceId: b.workspace().id, cwd, parentId: b.caller.agentId ?? null });
    b.started?.agent(a.id);
    if (!a.paneId) return `Started ${a.kind}.`;
    // Not "started" until it is past starting: it may stop at a question first (trusting the folder, a login).
    const r = await b.call("agent.wait", { agentIds: [a.id], until: ["working", "needs_input", "idle", "done", "failed", "exited"], timeoutMs: START_WAIT_MS }).catch(() => null);
    const now = r?.agents[0] ?? a;
    const { text } = await b.call("pane.read", { paneId: a.paneId, lines: 20 }).catch(() => ({ text: "" }));
    const state = now.state === "working" ? "is working on it" : now.state === "starting" ? "is still starting" : `is ${now.state.replace("_", " ")}: it may be waiting for an answer on its screen before it starts`;
    return `Started ${a.kind} in ${b.refs.of(a.paneId)} (in ${path.relative(b.workspace().root, cwd) || "the workspace's folder"}); it ${state}.\n` + untrusted(`${b.refs.of(a.paneId)} terminal`, `Its screen now:\n${text.trimEnd()}`);
  },
};

const waitTool: Tool = {
  acts: false,
  calls: ["window.list", "pane.list", "agent.list", "agent.wait", "pane.waitFor"],
  spec: {
    name: "wait",
    explores: false,
    description:
      "Wait, for a short while: until what you started reports back (`reports`: an agent done, failed or needing input, a command ended, a server up), until a terminal shows some text (already on its screen counts) or is back at its prompt, or until agents are done or need input. Give the refs of the windows to wait for (not for reports). Returns what each ended as; read them for details. Times out after `seconds` (default 120, at most 600); waiting again is fine.",
    schema: schema({ refs: { type: "array", items: ref }, until: { type: "string", enum: ["reports", "done", "prompt", "text"], description: "reports: what you started reports back; done: agents finished or need you; prompt: a terminal's command ended; text: a terminal printed `text`." }, text: { type: "string" }, all: { type: "boolean", description: "Agents: wait for all of them (default: the first)." }, seconds: { type: "number" } }, ["until"]),
  },
  async run(i, b) {
    const ms = num(i.seconds, 120, 600) * 1000;
    if (i.until === "reports") {
      if (!b.reports) throw new Error("what you start reports back by itself here: wait for done, prompt or text instead");
      const r = await b.reports(ms, b.signal);
      return r.length ? r.map((x) => `- ${x}`).join("\n") : "Nothing reported back during the wait.";
    }
    const wins = await Promise.all((Array.isArray(i.refs) ? i.refs : []).map((r) => windowOf(b, r)));
    if (!wins.length) throw new Error("give the refs to wait for");
    if (i.until === "done") {
      const agents = (await Promise.all(wins.map((w) => agentIn(b, w)))).filter((a): a is Agent => !!a);
      if (!agents.length) throw new Error("none of these has an agent: wait for prompt or text instead");
      const r = await b.call("agent.wait", { agentIds: agents.map((a) => a.id), until: ["done", "needs_input", "idle", "failed", "exited"], mode: i.all ? "all" : "any", timeoutMs: ms });
      return [r.timedOut ? "Still working after the wait." : "", ...r.agents.map((a) => `${a.paneId ? b.refs.of(a.paneId) : a.id}: ${agentLine(a)}`)].filter(Boolean).join("\n");
    }
    const out = await Promise.all(
      wins.map(async (w) => {
        if (w.kind !== "terminal") return `${b.refs.of(w.id)} is not a terminal`;
        const r = await b.call("pane.waitFor", { paneId: w.id, prompt: i.until === "prompt", text: i.until === "text" ? str(i.text) : undefined, timeoutMs: ms });
        const status = r.timedOut ? "still running after the wait" : r.matched ? (i.until === "text" ? "printed it" : `back at its prompt${r.exitCode !== null ? `, exit status ${r.exitCode}` : ""}`) : "closed";
        return untrusted(`${b.refs.of(w.id)} terminal`, `${status}\nLast lines:\n${r.tail.trimEnd()}`);
      }),
    );
    return out.join("\n\n");
  },
};

/** Keys `type` can press, as the terminal gets them, and as the approval shows them. */
const KEYS: Record<string, [string, string]> = {
  enter: ["\r", "⏎"],
  escape: ["\x1b", "Esc"],
  tab: ["\t", "⇥"],
  backspace: ["\x7f", "⌫"],
  space: [" ", "Space"],
  up: ["\x1b[A", "↑"],
  down: ["\x1b[B", "↓"],
  right: ["\x1b[C", "→"],
  left: ["\x1b[D", "←"],
  "ctrl-c": ["\x03", "⌃C"],
  "ctrl-d": ["\x04", "⌃D"],
};

const KEY_GAP_MS = 80;

const keysOf = (v: unknown): string[] => {
  const keys = Array.isArray(v) ? v.map(String) : [];
  const bad = keys.filter((k) => !KEYS[k]);
  if (bad.length) throw new Error(`no key ${bad.join(", ")}: use ${Object.keys(KEYS).join(", ")}`);
  return keys;
};

/** A terminal as people say it: the agent in it, else the folder it's in. */
async function terminalName(b: ToolContext, w: AppWindow, agent: Agent | null): Promise<string> {
  if (agent) return `${agent.kind === "claude" ? "Claude" : agent.kind === "codex" ? "Codex" : agent.kind}${agent.name ? ` “${agent.name}”` : ""}`;
  const pane = (await b.call("pane.list", {})).find((p) => p.id === w.id);
  const dir = pane ? path.relative(b.workspace().root, pane.cwd) || path.basename(pane.cwd) : null;
  return dir ? `the terminal in ${dir}` : windowName(w);
}

const typeTool: Tool = {
  acts: true,
  calls: ["window.list", "pane.list", "agent.list", "agent.send", "pane.write"],
  spec: {
    name: "type",
    explores: false,
    description:
      "Type into a terminal (a command) or into an agent (a message), and press return unless `submit` is false; or press `keys` (arrows, enter, escape, tab, ctrl-c…) to answer a menu or prompt on its screen, such as a yes/no or a list to pick from (down then enter picks the second item). Always asks the person first, showing exactly what and where. The fallback: use run for the project's own commands and agent to start work. Some commands are refused outright (root, piping downloads into a shell, credentials).",
    schema: schema({ ref, text: { type: "string" }, submit: { type: "boolean" }, keys: { type: "array", items: { type: "string", enum: Object.keys(KEYS) }, description: "Keys pressed after the text, in order." } }, ["ref"]),
  },
  target: (i, b) => b.refs.id(i.ref),
  async confirm(i, b) {
    const w = await otherWindow(b, i.ref, "type into");
    if (w.kind !== "terminal") throw new Error(`${String(i.ref)} is a ${w.kind}, not a terminal`);
    const text = str(i.text) ?? "";
    const keys = keysOf(i.keys);
    if (!text && !keys.length) throw new Error("give text or keys");
    const agent = await agentIn(b, w);
    if (!agent && text) {
      const why = denied(text);
      if (why) throw new Error(`refused: it ${why}. Ask the person to do it themselves if it's needed.`);
    }
    const where = await terminalName(b, w, agent);
    const pressed = keys.map((k) => KEYS[k]![1]).join(" ");
    const exact = [text, keys.length ? pressed : text && i.submit !== false ? "⏎" : ""].filter(Boolean).join("  ");
    const kind = agent ? (agent.kind === "claude" ? "Claude" : agent.kind === "codex" ? "Codex" : agent.kind) : null;
    // What "Always allow" covers: a command by its program (and subcommand), messages to an agent kind, key presses.
    const words = text.trim().split(/\s+/);
    const prefix = words[0] + (words[1] && /^[a-z][\w:.-]*$/.test(words[1]) ? ` ${words[1]}` : "");
    const rule = keys.length ? { key: `keys:${agent?.kind ?? "terminal"}`, label: `key presses in ${kind ?? "terminals"}` } : agent ? { key: `send:${agent.kind}`, label: `messages to ${kind}` } : { key: `type:${prefix}`, label: `commands starting “${prefix}”` };
    return { title: keys.length && !text ? `Press keys in ${where}` : agent ? `Send to ${where}` : `Type in ${where}`, exact, rule };
  },
  async run(i, b) {
    const w = await windowOf(b, i.ref);
    const agent = await agentIn(b, w);
    const text = str(i.text) ?? "";
    const keys = keysOf(i.keys);
    // Keys go to the terminal as they are, an agent's too: they answer what its screen shows.
    if (text && agent && !keys.length) await b.call("agent.send", { agentId: agent.id, text, submit: i.submit !== false });
    else {
      const submit = i.submit !== false && !keys.length;
      if (text || submit) await b.call("pane.write", { paneId: w.id, data: text + (submit ? "\r" : "") });
      if (text && submit) b.started?.command(w.id, `“${text.length > 60 ? text.slice(0, 59) + "…" : text}”`);
      // One at a time: a program reading its input in one chunk may take several keys for a paste.
      for (const k of keys) {
        await new Promise((r) => setTimeout(r, KEY_GAP_MS));
        await b.call("pane.write", { paneId: w.id, data: KEYS[k]![0] });
      }
    }
    return `Typed into ${String(i.ref)}.${agent || keys.length || i.submit === false ? " Read it to see what happened." : " You'll be told when the command ends."}`;
  },
};

export const AGENT_TOOLS: Tool[] = [agentTool, waitTool, typeTool];
