// Built-in transcript sources (Claude Code, Codex, Qwen Code, Copilot CLI). They
// use the same registry API another agent's source would.

import fs from "node:fs";
import path from "node:path";
import { shq } from "../shell.ts";
import { parseClaude, parseCodex, parseCopilot, parseQwen, type Obj } from "./parser.ts";
import { realDir, type LocateContext, type TranscriptRoot, type TranscriptSource, type TranscriptSources } from "./sources.ts";

/** Env var pointing the agent at a config dir, unless it is the default one. */
function envFor(name: string, dir: string, defaultDir: string): Record<string, string> | null {
  return dir === (realDir(defaultDir) ?? defaultDir) ? null : { [name]: dir };
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Claude Code: <config>/projects/<project>/<session>.jsonl, where config is
 * ~/.claude, $CLAUDE_CONFIG_DIR, the XDG dir a few mid-2025 versions used, or any
 * other home the core discovered (profiles; rootsIn, agents/homes.ts).
 * Deeper files (<session>/subagents/…) are subagent logs. Sessions outside the
 * default dir need CLAUDE_CONFIG_DIR to resume.
 */
export const claudeSource: TranscriptSource = {
  agent: "claude",
  title: "Claude Code",
  locate(ctx) {
    const xdg = ctx.env.XDG_CONFIG_HOME ?? path.join(ctx.home, ".config");
    const candidates = [path.join(ctx.home, ".claude"), ctx.env.CLAUDE_CONFIG_DIR, path.join(xdg, "claude")];
    return candidates.flatMap((c) => (c ? (this.rootsIn?.(c, ctx) ?? []) : []));
  },
  rootsIn(home, ctx) {
    const config = realDir(home);
    return config && realDir(path.join(config, "projects")) ? [claudeRoot(config, ctx)] : [];
  },
  rootFor(file, ctx) {
    const projects = path.dirname(path.dirname(file));
    if (path.basename(projects) !== "projects") return null;
    const config = realDir(path.dirname(projects));
    return config ? claudeRoot(config, ctx) : null;
  },
  // Qwen's records look alike but carry Gemini-style message.parts.
  sniff: (head) =>
    head.some((o) => (typeof o.sessionId === "string" && isObj(o.message) && "content" in o.message) || o.type === "summary" || o.type === "ai-title"),
  parse: parseClaude,
  forks: true,
  resume: (id, fork, settings) => `${settings["agents.claude.command"]} --resume ${shq(id)}${fork ? " --fork-session" : ""}`,
};

function claudeRoot(config: string, ctx: LocateContext): TranscriptRoot {
  return { agent: "claude", dir: path.join(config, "projects"), depth: 2, env: envFor("CLAUDE_CONFIG_DIR", config, path.join(ctx.home, ".claude")) };
}

/**
 * Codex: $CODEX_HOME (default ~/.codex)/sessions/YYYY/MM/DD/rollout-<date>-<uuid>.jsonl;
 * archived sessions move to archived_sessions/.
 */
export const codexSource: TranscriptSource = {
  agent: "codex",
  title: "Codex",
  locate(ctx) {
    const homes = [path.join(ctx.home, ".codex"), ctx.env.CODEX_HOME];
    return homes.flatMap((h) => (h ? (this.rootsIn?.(h, ctx) ?? []) : []));
  },
  rootsIn(h, ctx) {
    const home = realDir(h);
    return home ? CODEX_DIRS.filter((sub) => realDir(path.join(home, sub))).map((sub) => codexRoot(home, sub, ctx)) : [];
  },
  rootFor(file, ctx) {
    // Walk up to the nearest sessions folder.
    for (let d = path.dirname(file); d !== path.dirname(d); d = path.dirname(d)) {
      const sub = CODEX_DIRS.find((s) => s === path.basename(d));
      if (sub) {
        const home = realDir(path.dirname(d));
        return home ? codexRoot(home, sub, ctx) : null;
      }
    }
    return null;
  },
  sniff: (head) => head.some((o) => o.type === "session_meta" || (typeof o.type === "string" && typeof o.payload === "object")),
  parse: parseCodex,
  forks: true,
  resume: (id, fork, settings) => `${settings["agents.codex.command"]} ${fork ? "fork" : "resume"} ${shq(id)}`,
};

const CODEX_DIRS = ["sessions", "archived_sessions"];

function codexRoot(home: string, sub: string, ctx: LocateContext): TranscriptRoot {
  return { agent: "codex", dir: path.join(home, sub), env: envFor("CODEX_HOME", home, path.join(ctx.home, ".codex")) };
}

/**
 * Qwen Code: <base>/projects/<project>/chats/<session>.jsonl (archived ones in
 * chats/archive/), where base is $QWEN_RUNTIME_DIR, $QWEN_HOME or ~/.qwen.
 * Subagent logs (projects/<project>/subagents/…) are sidechains, skipped by the parser.
 */
export const qwenSource: TranscriptSource = {
  agent: "qwen",
  title: "Qwen Code",
  locate(ctx) {
    const bases = [path.join(ctx.home, ".qwen"), ctx.env.QWEN_HOME, ctx.env.QWEN_RUNTIME_DIR];
    const roots: TranscriptRoot[] = [];
    for (const b of bases) {
      const base = b && realDir(b);
      if (base && realDir(path.join(base, "projects"))) roots.push(qwenRoot(base, ctx));
    }
    return roots;
  },
  rootFor(file, ctx) {
    // <base>/projects/<project>/chats/[archive/]<session>.jsonl
    let chats = path.dirname(file);
    if (path.basename(chats) === "archive") chats = path.dirname(chats);
    const projects = path.dirname(path.dirname(chats));
    if (path.basename(chats) !== "chats" || path.basename(projects) !== "projects") return null;
    const base = realDir(path.dirname(projects));
    return base ? qwenRoot(base, ctx) : null;
  },
  sniff: (head) => head.some((o) => typeof o.sessionId === "string" && isObj(o.message) && Array.isArray(o.message.parts)),
  parse: parseQwen,
  forks: true,
  resume: (id, fork, settings) => `${settings["agents.qwen.command"]} --resume ${shq(id)}${fork ? " --fork-session" : ""}`,
};

function qwenRoot(base: string, ctx: LocateContext): TranscriptRoot {
  // QWEN_RUNTIME_DIR moves only the session data, so it is what resume needs.
  return { agent: "qwen", dir: path.join(base, "projects"), depth: 4, env: envFor("QWEN_RUNTIME_DIR", base, path.join(ctx.home, ".qwen")) };
}

/** GitHub Copilot CLI: $COPILOT_HOME (default ~/.copilot)/session-state/<session>/events.jsonl. Resumes from any folder. */
export const copilotSource: TranscriptSource = {
  agent: "copilot",
  title: "Copilot CLI",
  locate(ctx) {
    const homes = [path.join(ctx.home, ".copilot"), ctx.env.COPILOT_HOME];
    const roots: TranscriptRoot[] = [];
    for (const h of homes) {
      const home = h && realDir(h);
      if (home && realDir(path.join(home, "session-state"))) roots.push(copilotRoot(home, ctx));
    }
    return roots;
  },
  rootFor(file, ctx) {
    const state = path.dirname(path.dirname(file));
    if (path.basename(file) !== "events.jsonl" || path.basename(state) !== "session-state") return null;
    const home = realDir(path.dirname(state));
    return home ? copilotRoot(home, ctx) : null;
  },
  sniff: (head) => head.some((o) => o.type === "session.start" && isObj(o.data)),
  parse: parseCopilot,
  // Forking is only /fork inside a session.
  forks: false,
  resume: (id, _fork, settings) => `${settings["agents.copilot.command"]} --resume=${shq(id)}`,
};

function copilotRoot(home: string, ctx: LocateContext): TranscriptRoot {
  return {
    agent: "copilot",
    dir: path.join(home, "session-state"),
    depth: 2,
    fileName: "events.jsonl",
    env: envFor("COPILOT_HOME", home, path.join(ctx.home, ".copilot")),
  };
}

export function registerBuiltinSources(sources: TranscriptSources): TranscriptSources {
  sources.register(claudeSource);
  sources.register(codexSource);
  sources.register(qwenSource);
  sources.register(copilotSource);
  return sources;
}
