// Where agents keep their config: the dirs hooks go into, transcripts are read
// from, and that a resume needs in its env. Users keep them in odd places (a
// profile per account through $CLAUDE_CONFIG_DIR, dotfile repos, $CODEX_HOME), and
// the core, launched from the Dock, rarely has their shell's variables. So homes
// are discovered, not configured: defaults and the core's env, what hooks report
// (the agent's own env, transcript paths), a bounded scan for dirs that look like
// one, and the agents.homes setting for the rest. One registry, kept in SQLite.

import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AgentHome, AgentKind } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import type { LocateContext } from "../search/sources.ts";
import { decodeDoc, decodeHome } from "../stored.ts";

const log = logger("homes");

export interface HomeSpec {
  agent: AgentKind;
  /** The variable that points the agent at a home. */
  env: string;
  /** Homes without it; "~" is the home dir, "$XDG" the config dir. */
  defaults: string[];
  /** What a home contains: every `all` entry and at least one `any`. */
  fingerprint: { all: string[]; any: string[] };
  /** The variable's value for a home, when it isn't the home itself (Gemini's names the parent). */
  envValue?: (dir: string) => string;
}

export const HOME_SPECS: HomeSpec[] = [
  { agent: "claude", env: "CLAUDE_CONFIG_DIR", defaults: ["~/.claude", "$XDG/claude"], fingerprint: { all: ["projects"], any: ["settings.json", ".claude.json", "history.jsonl"] } },
  { agent: "codex", env: "CODEX_HOME", defaults: ["~/.codex"], fingerprint: { all: [], any: ["sessions", "archived_sessions"] } },
  { agent: "gemini", env: "GEMINI_CLI_HOME", defaults: ["~/.gemini"], fingerprint: { all: ["settings.json"], any: ["tmp", "oauth_creds.json", "google_accounts.json"] }, envValue: (dir) => path.dirname(dir) },
];

/** Under $HOME, also look one level into dirs named like these (profiles, config dirs). */
const NESTED = /claude|codex|gemini|agent|profile|^\.config$/i;
const SKIP = new Set(["Library", "node_modules", ".Trash", "Applications", "Movies", "Music", "Pictures", ".cache", ".npm", ".pnpm-store", ".git", ".cargo", ".rustup"]);

const real = (p: string): string | null => {
  try {
    return fs.statSync(p).isDirectory() ? fs.realpathSync(p) : null;
  } catch {
    return null;
  }
};
const has = (dir: string, name: string) => fs.existsSync(path.join(dir, name));

/** Whether `dir` looks like a home of `spec`'s agent. */
export function looksLikeHome(spec: HomeSpec, dir: string): boolean {
  return spec.fingerprint.all.every((n) => has(dir, n)) && (spec.fingerprint.any.length === 0 || spec.fingerprint.any.some((n) => has(dir, n)));
}

function expand(p: string, ctx: LocateContext): string {
  const xdg = ctx.env.XDG_CONFIG_HOME || path.join(ctx.home, ".config");
  return p.replace(/^~(?=$|\/)/, ctx.home).replace(/^\$XDG(?=$|\/)/, xdg);
}

/** Candidate dirs under home: its own subdirs, and one level into those named like NESTED. */
function scanDirs(home: string): string[] {
  const out: string[] = [];
  const list = (d: string) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !SKIP.has(e.name));
    } catch {
      return [];
    }
  };
  for (const e of list(home)) {
    const d = path.join(home, e.name);
    out.push(d);
    if (NESTED.test(e.name)) for (const c of list(d)) out.push(path.join(d, c.name));
  }
  return out;
}

export class AgentHomes {
  #db: DatabaseSync | null;
  #homes = new Map<string, AgentHome>();
  #ctx: () => LocateContext;
  #extra: () => string[];

  /** `extra`: dirs from the agents.homes setting. */
  constructor(db: DatabaseSync | null, ctx: () => LocateContext, extra: () => string[] = () => []) {
    this.#db = db;
    this.#ctx = ctx;
    this.#extra = extra;
    db?.exec(`CREATE TABLE IF NOT EXISTS agent_homes (dir TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
    for (const r of (db?.prepare(`SELECT doc FROM agent_homes`).all() ?? []) as { doc: string }[]) {
      const h = decodeDoc("agent home", r.doc, decodeHome);
      if (!h) continue;
      if (real(h.dir)) this.#homes.set(h.dir, h);
      else db?.prepare(`DELETE FROM agent_homes WHERE dir = ?`).run(h.dir); // gone
    }
  }

  all(agent?: AgentKind): AgentHome[] {
    const order = (h: AgentHome) => HOME_SPECS.findIndex((s) => s.agent === h.agent);
    return [...this.#homes.values()].filter((h) => !agent || h.agent === agent).sort((a, b) => order(a) - order(b) || a.firstSeen - b.firstSeen);
  }

  /** Defaults, the core's env, the setting and the scan. Returns homes that are new. */
  discover(): AgentHome[] {
    const ctx = this.#ctx();
    const added: AgentHome[] = [];
    const add = (h: AgentHome | null) => h && added.push(h);
    for (const spec of HOME_SPECS) {
      for (const d of spec.defaults) add(this.#see(spec, expand(d, ctx), "default"));
      const fromEnv = ctx.env[spec.env];
      if (fromEnv) add(this.#see(spec, spec.agent === "gemini" ? path.join(fromEnv, ".gemini") : fromEnv, "env"));
    }
    for (const d of this.#extra()) {
      const dir = expand(d, ctx);
      for (const spec of HOME_SPECS) if (real(dir) && looksLikeHome(spec, dir)) add(this.#see(spec, dir, "setting"));
    }
    for (const dir of scanDirs(ctx.home)) for (const spec of HOME_SPECS) if (looksLikeHome(spec, dir)) add(this.#see(spec, dir, "scan"));
    return added;
  }

  /** A home a running agent reported (its env, or where its transcript is). Returns it if new. */
  learn(agent: AgentKind, dir: string, via: "hook" | "transcript"): AgentHome | null {
    const spec = HOME_SPECS.find((s) => s.agent === agent);
    return spec ? this.#see(spec, agent === "gemini" && via === "hook" ? path.join(dir, ".gemini") : dir, via) : null;
  }

  /** The home a transcript lives in: the nearest ancestor that looks like one. */
  homeOfTranscript(agent: AgentKind, file: string): string | null {
    const spec = HOME_SPECS.find((s) => s.agent === agent);
    if (!spec) return null;
    for (let d = path.dirname(file), i = 0; d !== path.dirname(d) && i < 8; d = path.dirname(d), i++) if (looksLikeHome(spec, d)) return d;
    return null;
  }

  #see(spec: HomeSpec, dir: string, via: AgentHome["via"][number]): AgentHome | null {
    const r = real(dir);
    if (!r || (via !== "default" && via !== "env" && !looksLikeHome(spec, r))) return null;
    const now = Date.now();
    const known = this.#homes.get(r);
    if (known) {
      const viaNew = !known.via.includes(via);
      if (viaNew) known.via.push(via);
      if (viaNew || now - known.lastSeen > 3600_000) {
        known.lastSeen = now;
        this.#save(known);
      }
      return null;
    }
    const ctx = this.#ctx();
    const isDefault = spec.defaults.some((d) => real(expand(d, ctx)) === r);
    const home: AgentHome = { agent: spec.agent, dir: r, via: [via], env: isDefault ? null : { [spec.env]: spec.envValue ? spec.envValue(r) : r }, firstSeen: now, lastSeen: now };
    this.#homes.set(r, home);
    this.#save(home);
    log.info(`${spec.agent} home ${r} (${via})`);
    return home;
  }

  #save(h: AgentHome): void {
    this.#db?.prepare(`INSERT OR REPLACE INTO agent_homes (dir, doc) VALUES (?, ?)`).run(h.dir, JSON.stringify(h));
  }
}
