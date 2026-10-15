// Scenarios for the phone driver's throwaway core: what the Mac has open when the
// phone looks at it. A scenario file (tools/phone/scenarios/<name>.ts) exports a
// Scenario, or a function of the ScenarioContext that returns one: workspaces,
// each with terminals, and a terminal is a command, a folder and an environment
// (anything that runs in a shell drops in: a stand-in agent, a recorded session
// played back). One that is an agent can name the hook events it would send, so
// cmd shows it working, waiting for you or done; the core gets them once it has
// detected the agent. The driver seeds the scenario on every start, so it starts
// the same each time.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentKind, PaneId } from "../../../packages/protocol/src/model.ts";
import type { Connection } from "./harness.ts";
import { root as repoRoot, waitFor } from "./harness.ts";

export type HookEvent = [event: string, payload: Record<string, unknown>];

export interface ScenarioPane {
  /** What it is, for the driver's output; the phone shows the terminal's own title. */
  name: string;
  /** Typed into the shell once it starts; none: a plain shell. */
  command?: string;
  /** Its folder; relative to the workspace's (default: the workspace's). */
  cwd?: string;
  env?: Record<string, string>;
  /** It runs an agent: wait until cmd detects it, then send these hook events as the agent would. */
  agent?: { kind: AgentKind; hooks?: HookEvent[] };
}

export interface ScenarioWorkspace {
  /** Its folder's name under the scenario's work folder; null: Home. */
  name: string | null;
  panes: ScenarioPane[];
}

export interface Scenario {
  description: string;
  /** Settings for the core, over the driver's own (remote access, quiet agents). */
  settings?: Record<string, unknown>;
  workspaces: ScenarioWorkspace[];
}

export interface ScenarioContext {
  /** The repository. */
  root: string;
  /** The scenario core's state folder. */
  home: string;
  /** Holds `claude` and `htop` stand-ins (scripts/readme-shots), detected as the real ones. */
  bin: string;
  /** A workspace's folder (made when seeded). */
  work(name: string): string;
  /** A stand-in Claude Code session (scripts/readme-shots/fake-claude.mjs: working, ask, done) and its hook events. */
  claude(demo: string, cwd: string): Pick<ScenarioPane, "command" | "agent">;
}

export type ScenarioFile = Scenario | ((ctx: ScenarioContext) => Scenario);

export const scenariosDir = path.join(repoRoot, "tools/phone/scenarios");

export const scenarioNames = (): string[] =>
  fs
    .readdirSync(scenariosDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.slice(0, -3))
    .sort();

/** The scenario core's folder, the stand-ins in its bin/ and a quiet zsh; the scenario files read this. */
export async function scenarioContext(home: string): Promise<ScenarioContext> {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  // `claude` on PATH is the fake: argv[1] ends in /claude, so cmd classifies it as Claude.
  for (const [name, file] of [["claude", "fake-claude.mjs"], ["htop", "fake-htop.mjs"]] as const) {
    const target = path.join(repoRoot, "scripts/readme-shots", file);
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nimport(${JSON.stringify(target)});\n`, { mode: 0o755 });
  }
  const fake = (await import(pathToFileURL(path.join(repoRoot, "scripts/readme-shots/fake-claude.mjs")).href)) as {
    SCENARIOS: Record<string, { session: string; hooks(cwd: string): HookEvent[] }>;
  };
  return {
    root: repoRoot,
    home,
    bin,
    work: (name) => path.join(home, "work", name),
    claude(demo, cwd) {
      const s = fake.SCENARIOS[demo];
      if (!s) throw new Error(`fake-claude has no “${demo}” session. It has: ${Object.keys(fake.SCENARIOS).join(", ")}.`);
      return {
        command: `${path.join(bin, "claude")} --demo=${demo}`,
        agent: { kind: "claude", hooks: s.hooks(cwd).map(([event, payload]) => [event, { hook_event_name: event, session_id: s.session, cwd, ...payload }]) },
      };
    },
  };
}

/** What's wrong with a scenario, one line each; none: it's good. */
export function problems(s: unknown): string[] {
  const out: string[] = [];
  const sc = s as Partial<Scenario> | null;
  if (!sc || typeof sc !== "object") return ["It isn't an object."];
  if (typeof sc.description !== "string") out.push("description: a line saying what it shows.");
  if (sc.settings !== undefined && (typeof sc.settings !== "object" || sc.settings === null)) out.push("settings: an object of setting keys.");
  if (!Array.isArray(sc.workspaces) || !sc.workspaces.length) return [...out, "workspaces: at least one."];
  sc.workspaces.forEach((w, i) => {
    const at = `workspaces[${i}]`;
    if (w.name !== null && (typeof w.name !== "string" || !/^[\w.-]+$/.test(w.name))) out.push(`${at}.name: a folder name, or null for Home.`);
    if (!Array.isArray(w.panes)) {
      out.push(`${at}.panes: a list.`);
      return;
    }
    w.panes.forEach((p, j) => {
      const pat = `${at}.panes[${j}]`;
      if (typeof p.name !== "string" || !p.name) out.push(`${pat}.name: what it is.`);
      if (p.command !== undefined && typeof p.command !== "string") out.push(`${pat}.command: a command line.`);
      if (p.env && Object.values(p.env).some((v) => typeof v !== "string")) out.push(`${pat}.env: strings only.`);
      if (p.agent && (typeof p.agent.kind !== "string" || (p.agent.hooks && !p.agent.hooks.every((h) => Array.isArray(h) && typeof h[0] === "string")))) out.push(`${pat}.agent: { kind, hooks: [[event, payload]…] }.`);
    });
  });
  return out;
}

/** Load tools/phone/scenarios/<name>.ts for this context; throws saying what's wrong. */
export async function loadScenario(name: string, ctx: ScenarioContext): Promise<Scenario> {
  const file = path.join(scenariosDir, `${name}.ts`);
  if (!fs.existsSync(file)) throw new Error(`There's no scenario “${name}”. There are: ${scenarioNames().join(", ")}.`);
  const mod = (await import(pathToFileURL(file).href)) as { default?: ScenarioFile };
  if (!mod.default) throw new Error(`${path.relative(repoRoot, file)} has no default export.`);
  const s = typeof mod.default === "function" ? mod.default(ctx) : mod.default;
  const bad = problems(s);
  if (bad.length) throw new Error(`${path.relative(repoRoot, file)} isn't a scenario:\n  ${bad.join("\n  ")}`);
  return s;
}

export interface Seeded {
  name: string;
  paneId: PaneId;
  workspace: string;
}

/** Open the scenario on the core: its workspaces, then each terminal; agents wait to be detected, then get their hook events. */
export async function seed(conn: Connection, s: Scenario, ctx: ScenarioContext, log: (line: string) => void): Promise<Seeded[]> {
  const call = conn.client.call.bind(conn.client);
  const out: Seeded[] = [];
  const agents: { pane: ScenarioPane; paneId: PaneId }[] = [];
  // What a PTY host kept from the last start (one stop couldn't reach) goes first, so it starts the same each time.
  const left = await call("pane.list", {});
  for (const p of left) await call("pane.kill", { paneId: p.id });
  if (left.length) await waitFor(async () => (await call("pane.list", {})).length === 0, "the last start's terminals to close");
  for (const w of s.workspaces) {
    let workspaceId: string | undefined;
    let dir: string | undefined;
    if (w.name) {
      dir = ctx.work(w.name);
      fs.mkdirSync(dir, { recursive: true });
      // A repository of its own: inside this checkout (a linked worktree) its agents would take the branch's name.
      if (!fs.existsSync(path.join(dir, ".git"))) execFileSync("git", ["init", "-q", "-b", "main", dir]);
      workspaceId = (await call("workspace.open", { path: dir })).workspace.id;
    }
    for (const p of w.panes) {
      const cwd = p.cwd ? path.resolve(dir ?? ctx.home, p.cwd) : dir;
      if (cwd) fs.mkdirSync(cwd, { recursive: true });
      const pane = await call("pane.create", { workspaceId, cwd, command: p.command, env: p.env });
      out.push({ name: p.name, paneId: pane.id, workspace: w.name ?? "Home" });
      if (p.agent) agents.push({ pane: p, paneId: pane.id });
    }
  }
  for (const { pane, paneId } of agents) {
    await waitFor(async () => (await call("agent.list", {})).some((a) => a.paneId === paneId), `cmd to detect the agent in “${pane.name}”`, 20_000);
    for (const [event, payload] of pane.agent!.hooks ?? []) await call("hook.ingest", { paneId, agent: pane.agent!.kind, event, payload });
  }
  for (const p of out) log(`  ${p.paneId.slice(0, 8)}  ${p.workspace.padEnd(8)} ${p.name}`);
  return out;
}
