// Built-in transcript sources (Claude Code, Codex). They use the same registry
// API another agent's source would.

import fs from "node:fs";
import path from "node:path";
import { shq } from "../shell.ts";
import { parseClaude, parseCodex } from "./parser.ts";
import { realDir, type LocateContext, type TranscriptRoot, type TranscriptSource, type TranscriptSources } from "./sources.ts";

const list = (d: string) => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};

/** Env var pointing the agent at a config dir, unless it is the default one. */
function envFor(name: string, dir: string, defaultDir: string): Record<string, string> | null {
  return dir === (realDir(defaultDir) ?? defaultDir) ? null : { [name]: dir };
}

/**
 * Claude Code: <config>/projects/<project>/<session>.jsonl, where config is
 * ~/.claude, $CLAUDE_CONFIG_DIR, a ~/.claude-profiles/* profile or the XDG dir.
 * Deeper files (<session>/subagents/…) are subagent logs. Sessions outside the
 * default dir need CLAUDE_CONFIG_DIR to resume.
 */
export const claudeSource: TranscriptSource = {
  agent: "claude",
  title: "Claude Code",
  locate(ctx) {
    const xdg = ctx.env.XDG_CONFIG_HOME ?? path.join(ctx.home, ".config");
    const candidates = [
      path.join(ctx.home, ".claude"),
      ctx.env.CLAUDE_CONFIG_DIR,
      ...list(path.join(ctx.home, ".claude-profiles")).map((p) => path.join(ctx.home, ".claude-profiles", p)),
      path.join(xdg, "claude"),
    ];
    const roots: TranscriptRoot[] = [];
    for (const c of candidates) {
      const config = c && realDir(c);
      if (config && realDir(path.join(config, "projects"))) roots.push(claudeRoot(config, ctx));
    }
    return roots;
  },
  rootFor(file, ctx) {
    const projects = path.dirname(path.dirname(file));
    if (path.basename(projects) !== "projects") return null;
    const config = realDir(path.dirname(projects));
    return config ? claudeRoot(config, ctx) : null;
  },
  sniff: (head) => head.some((o) => typeof o.sessionId === "string" || o.type === "summary" || o.type === "ai-title"),
  parse: parseClaude,
  resume: (id, fork, settings) => `${settings["agents.claude.command"]} --resume ${shq(id)}${fork ? " --fork-session" : ""}`,
};

function claudeRoot(config: string, ctx: LocateContext): TranscriptRoot {
  return { agent: "claude", dir: path.join(config, "projects"), depth: 2, env: envFor("CLAUDE_CONFIG_DIR", config, path.join(ctx.home, ".claude")) };
}

/** Codex: $CODEX_HOME (default ~/.codex)/sessions/YYYY/MM/DD/rollout-<date>-<uuid>.jsonl. */
export const codexSource: TranscriptSource = {
  agent: "codex",
  title: "Codex",
  locate(ctx) {
    const homes = [path.join(ctx.home, ".codex"), ctx.env.CODEX_HOME];
    const roots: TranscriptRoot[] = [];
    for (const h of homes) {
      const home = h && realDir(h);
      if (home && realDir(path.join(home, "sessions"))) roots.push(codexRoot(home, ctx));
    }
    return roots;
  },
  rootFor(file, ctx) {
    // Walk up to the nearest "sessions" folder.
    for (let d = path.dirname(file); d !== path.dirname(d); d = path.dirname(d)) {
      if (path.basename(d) === "sessions") {
        const home = realDir(path.dirname(d));
        return home ? codexRoot(home, ctx) : null;
      }
    }
    return null;
  },
  sniff: (head) => head.some((o) => o.type === "session_meta" || (typeof o.type === "string" && typeof o.payload === "object")),
  parse: parseCodex,
  resume: (id, fork, settings) => `${settings["agents.codex.command"]} ${fork ? "fork" : "resume"} ${shq(id)}`,
};

function codexRoot(home: string, ctx: LocateContext): TranscriptRoot {
  return { agent: "codex", dir: path.join(home, "sessions"), env: envFor("CODEX_HOME", home, path.join(ctx.home, ".codex")) };
}

export function registerBuiltinSources(sources: TranscriptSources): TranscriptSources {
  sources.register(claudeSource);
  sources.register(codexSource);
  return sources;
}
