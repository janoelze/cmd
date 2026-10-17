// Quick Commands as one feature (docs/58-quick-commands.md; kernel/features.ts): the file's
// service, its methods and running one. The caller says what it is looking at (QuickContext);
// the core adds the workspace, the branch, the clipboard and the time, fills the body in
// (protocol quick.ts: values quoted for a shell, as they are for an agent's prompt) and sends
// it where its target says: typed into the selected terminal, a new terminal, or a window.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fillQuick, parseQuick, QUICK_FILE, quickEnv, quickMode, RpcError, type Placement, type QuickCommand, type QuickContext, type QuickMethods, type QuickResolved, type QuickRun, type QuickVariable } from "@cmd/protocol";
import type { CoreContext } from "../kernel/context.ts";
import type { Feature } from "../kernel/features.ts";
import type { HandlerSlice } from "../kernel/handlers.ts";
import { placeOf } from "../lib/checkout.ts";
import { expandHome } from "../windows/builtin.ts";
import { QuickService } from "./service.ts";

/** One service per core (tests make several cores). */
const services = new WeakMap<CoreContext, QuickService>();

/** The core's Quick Commands: quick-commands.json beside settings.json; in memory when settings are (tests). */
export function quickOf(core: CoreContext): QuickService {
  let s = services.get(core);
  if (!s) {
    s = new QuickService(core.settings.path ? path.join(path.dirname(core.settings.path), QUICK_FILE) : null);
    s.on("changed", () => core.broadcast({ type: "quick.changed" }));
    services.set(core, s);
  }
  return s;
}

/** What a missing variable needs, said to the person. */
const NEEDS: Record<string, string> = {
  file: "Select a file first.",
  selection: "Select some text first.",
  clipboard: "The clipboard is empty.",
  branch: "The folder isn't in a git repository.",
  repo: "The folder isn't in a git repository.",
  url: "Select a browser window first.",
};

const pad = (n: number) => String(n).padStart(2, "0");

/** The clipboard's text (macOS; only read when a body uses it). */
function clipboard(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    return execFileSync("pbpaste", { encoding: "utf8", timeout: 1000, maxBuffer: 4 * 1024 * 1024 }) || undefined;
  } catch {
    return undefined;
  }
}

interface Prepared {
  command: QuickCommand;
  resolved: QuickResolved;
  workspaceId: string;
  folder: string;
  /** The selected terminal, and the agent in it (typed text goes to it as a prompt). */
  paneId: string | null;
  agentId: string | null;
  env: Record<string, string>;
  cwd: string;
}

function prepare(core: CoreContext, id: string, ctx: QuickContext = {}, values: Record<string, string> = {}, from: Placement = {}): Prepared {
  const command = quickOf(core).get(id);
  if (!command) throw RpcError.of("notFound", `no Quick Command "${id}" (cmd quick lists them)`);
  const pane = ctx.paneId ? core.panes.get(ctx.paneId) : null;
  const ws = core.place({ workspaceId: ctx.workspaceId ?? pane?.workspaceId ?? from.workspaceId, callerPaneId: from.callerPaneId }, { path: ctx.folder });
  const folder = ctx.folder || pane?.cwd || ws.root;
  const agent = pane?.agentId ? core.agents.get(pane.agentId) : null;
  const agentId = agent && agent.state !== "exited" ? agent.id : null;
  const target = command.target ?? "type";
  const parsed = parseQuick(command.body);
  if (parsed.errors.length) throw RpcError.of("invalidParams", `"${command.name}" can't run: ${parsed.errors.join("; ")}`);
  const used = new Set<QuickVariable>([...parsed.vars, ...(command.cwd ? parseQuick(command.cwd).vars : [])]);
  const place = used.has("branch") || used.has("repo") ? placeOf(folder) : null;
  const now = new Date();
  const vars: Partial<Record<QuickVariable, string>> = {
    folder,
    workspace: ws.root,
    file: ctx.file,
    selection: ctx.selection,
    clipboard: used.has("clipboard") ? clipboard() : undefined,
    branch: place?.branch ?? undefined,
    repo: place?.top,
    url: ctx.url,
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
  // Typed into a terminal only when there is one; else it runs in a new one, as a shell command.
  const into = target === "type" && pane ? (agentId ? "agent" : "shell") : null;
  const mode = quickMode(target, command.body, into === "agent");
  const filled = fillQuick(parsed, mode, vars, values);
  const dir = command.cwd ? fillQuick(parseQuick(command.cwd), "text", vars, values) : { text: folder, missing: [] };
  const missing = [...new Set([...filled.missing, ...dir.missing])];
  return {
    command,
    resolved: { text: missing.length ? null : filled.text, missing, asks: parsed.asks, mode },
    workspaceId: ws.id,
    folder,
    paneId: into ? pane!.id : null,
    agentId: into === "agent" ? agentId : null,
    env: quickEnv(parsed, vars, values),
    cwd: path.resolve(folder, expandHome(dir.text ?? folder)),
  };
}

export function runQuick(core: CoreContext, id: string, ctx: QuickContext = {}, values: Record<string, string> = {}, confirmed = false, from: Placement = {}): QuickRun | Promise<QuickRun> {
  const p = prepare(core, id, ctx, values, from);
  const { command, resolved } = p;
  if (resolved.text === null) throw RpcError.of("failed", `"${command.name}" needs ${resolved.missing.map((m) => `{{${m}}}`).join(", ")}. ${NEEDS[resolved.missing[0]!] ?? ""}`.trim());
  if (command.confirm && !confirmed) throw RpcError.of("denied", `"${command.name}" asks before it runs (${resolved.text}): run it once the person said yes (cmd quick run --yes)`);
  const text = resolved.text;
  const target = command.target ?? "type";
  if (target === "open") {
    const t = /^[a-z][\w+.-]*:/i.test(text) ? text : path.resolve(p.folder, expandHome(text.trim()));
    const ws = core.workspaces.mustOpen(p.workspaceId);
    const w = core.windows.openTarget(t, ws);
    if (!w) throw RpcError.of("failed", `cmd has no window that opens ${t}`);
    core.opened(w);
    return { text, windowId: w.id };
  }
  if (p.paneId) {
    const submit = command.submit ?? true;
    if (p.agentId) return core.agents.send(p.agentId, text, submit).then(() => ({ text, paneId: p.paneId! }));
    core.panes.write(p.paneId, submit ? `${text}\r` : text);
    return { text, paneId: p.paneId };
  }
  const pane = core.panes.create({ cwd: p.cwd, command: text, workspaceId: core.workspaces.mustOpen(p.workspaceId).id, env: p.env });
  core.usage.window("terminal");
  return { text, paneId: pane.id };
}

export const quickFeature = {
  id: "quick",
  handlers: (core: CoreContext): HandlerSlice<keyof QuickMethods> => ({
    "quick.list": () => quickOf(core).list(),
    "quick.save": (p) => quickOf(core).save(p.command, p.before),
    "quick.remove": (p) => (quickOf(core).remove(p.id), null),
    "quick.move": (p) => (quickOf(core).move(p.id, p.before), null),
    "quick.run": (p) => runQuick(core, p.id, p.context, p.values, p.confirmed, p),
    "quick.resolve": (p) => prepare(core, p.id, p.context, p.values, p).resolved,
  }),
  startup: { label: "Reading Quick Commands", run: (core: CoreContext) => quickOf(core).watch() },
  dispose: (core: CoreContext) => services.get(core)?.dispose(),
} satisfies Feature;
