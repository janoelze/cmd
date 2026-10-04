// Transcript source registry. Each agent whose sessions cmd can search and resume
// is a TranscriptSource: where its transcripts live, how to tell its files apart,
// how to read them and how to pick a session up again. Built-ins (Claude, Codex)
// are registered in builtin.ts through the same API other agents will use.
//
// Roots are plain data so they can cross into the indexing worker, which builds
// its own registry and looks sources up by agent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentKind, Settings } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { envPrefix } from "../shell.ts";
import { headObjects, type Obj, type SessionDocument, type TranscriptText } from "./parser.ts";

const log = logger("search");

/** A folder of transcripts. */
export interface TranscriptRoot {
  /** Whose transcripts these are; null: a mixed folder (archives), each file's agent is sniffed. */
  agent: AgentKind | null;
  dir: string;
  /** How deep transcripts sit below dir (1 = directly in it); omitted = any depth. */
  depth?: number;
  /** Only files with this name (Copilot: events.jsonl); omitted = every *.jsonl. */
  fileName?: string;
  /** Environment the agent needs to find these sessions again (CLAUDE_CONFIG_DIR, …); null = none. */
  env: Record<string, string> | null;
}

export interface LocateContext {
  /** Home folder to look in ($CMD_TRANSCRIPTS_HOME in tests). */
  home: string;
  /** Environment to read agent config overrides from (empty when home is overridden). */
  env: Record<string, string | undefined>;
}

export interface TranscriptSource {
  agent: AgentKind;
  /** "Claude Code", "Codex", … */
  title: string;
  /** Where this agent keeps transcripts on this machine; only folders that exist. */
  locate(ctx: LocateContext): TranscriptRoot[];
  /**
   * The root a transcript belongs to, from a path a live agent reported (hooks):
   * finds locations locate() doesn't know about, like an unusual config dir.
   */
  rootFor?(transcriptPath: string, ctx: LocateContext): TranscriptRoot | null;
  /** Whether a transcript is this agent's, from its first JSON lines (for mixed folders). */
  sniff(head: Obj[]): boolean;
  parse(text: TranscriptText, path: string): SessionDocument | null;
  /** Whether resume can fork a session (continue it as a new one). */
  forks: boolean;
  /** Shell command that resumes (or forks) a session; the root's env is added by the caller. */
  resume(sessionId: string, fork: boolean, settings: Settings): string;
}

export function locateContext(): LocateContext {
  const home = process.env.CMD_TRANSCRIPTS_HOME;
  return home ? { home, env: {} } : { home: os.homedir(), env: process.env };
}

/** "~" and "~/…" (or "~\…" on Windows) under home, joined with the platform's separator. */
export const expandHome = (p: string, home: string) => (p === "~" ? home : /^~[\\/]/.test(p) ? path.join(home, p.slice(2)) : p);

export class TranscriptSources {
  #sources = new Map<string, TranscriptSource>();

  register(source: TranscriptSource): void {
    if (this.#sources.has(source.agent)) throw new Error(`transcript source already registered: ${source.agent}`);
    this.#sources.set(source.agent, source);
  }

  get(agent: AgentKind): TranscriptSource | undefined {
    return this.#sources.get(agent);
  }

  all(): TranscriptSource[] {
    return [...this.#sources.values()];
  }

  /** Every source's roots plus extra mixed folders (archives), without duplicates. */
  locate(ctx: LocateContext, extraDirs: string[] = []): TranscriptRoot[] {
    const roots: TranscriptRoot[] = [];
    for (const s of this.all()) {
      try {
        roots.push(...s.locate(ctx));
      } catch (err) {
        log.error(`locating ${s.agent} transcripts: ${(err as Error).message}`);
      }
    }
    for (const d of extraDirs) {
      const dir = expandHome(d, ctx.home);
      if (isDir(dir)) roots.push({ agent: null, dir, depth: 2, env: null });
    }
    const seen = new Set<string>();
    return roots.filter((r) => !seen.has(r.dir) && seen.add(r.dir));
  }

  /** The root for a transcript a live agent reported, unless a known root already covers it. */
  learn(agent: AgentKind, transcriptPath: string, known: TranscriptRoot[], ctx: LocateContext): TranscriptRoot | null {
    if (!transcriptPath.endsWith(".jsonl") || known.some((r) => covers(r, transcriptPath))) return null;
    const source = this.get(agent);
    const root = source?.rootFor?.(transcriptPath, ctx) ?? null;
    return root && covers(root, transcriptPath) ? root : null;
  }

  /** Parses a transcript; in a mixed folder the agent is sniffed, else every source is tried. */
  parse(root: TranscriptRoot, text: TranscriptText, file: string): SessionDocument | null {
    const fixed = root.agent ? this.get(root.agent) : undefined;
    if (root.agent) return fixed?.parse(text, file) ?? null;
    const head = headObjects(text, 20);
    const sniffed = this.all().filter((s) => s.sniff(head));
    for (const s of sniffed.length ? sniffed : this.all()) {
      const doc = s.parse(text, file);
      if (doc) return doc;
    }
    return null;
  }

  /** Environment needed to resume the session a transcript belongs to (from its folder). */
  resumeEnv(agent: AgentKind, transcriptPath: string, ctx: LocateContext): Record<string, string> | null {
    return this.get(agent)?.rootFor?.(transcriptPath, ctx)?.env ?? null;
  }

  /** Command that resumes (or forks) a session; typed into the shell so wrappers apply. */
  resumeCommand(agent: AgentKind, sessionId: string, env: Record<string, string> | null, fork: boolean, settings: Settings): string {
    const source = this.get(agent);
    if (!source) throw new Error(`can't resume ${agent} sessions`);
    if (fork && !source.forks) throw new Error(`${source.title} can't fork sessions`);
    return envPrefix(env) + source.resume(sessionId, fork, settings);
  }
}

/** Whether a transcript path lies within a root (at an allowed depth). */
export function covers(root: TranscriptRoot, file: string): boolean {
  const rel = path.relative(root.dir, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
  if (root.fileName && path.basename(file) !== root.fileName) return false;
  return root.depth === undefined || rel.split(path.sep).length <= root.depth;
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The real path of a folder, or null if it doesn't exist. */
export function realDir(p: string): string | null {
  try {
    const real = fs.realpathSync(p);
    return isDir(real) ? real : null;
  } catch {
    return null;
  }
}
