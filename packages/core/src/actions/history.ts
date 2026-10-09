// Ranking Workspace Actions by what you actually run (docs/39, "Ranking"): the
// commands typed in this folder's terminals (`command` events) matched to the
// actions they ran, weighed by age; and the commands run here often that no
// file names, offered as "From your history".

import path from "node:path";
import type { WorkspaceAction } from "@cmd/protocol";
import { classify } from "./classify.ts";

/** A command as the log has it. */
export interface Ran {
  command: string;
  cwd: string;
  at: number;
  exitCode: number | null;
}

/** A run 14 days ago counts half as much as one today. */
const HALF_LIFE = 14 * 86400_000;
const weight = (at: number, now: number) => 0.5 ** (Math.max(0, now - at) / HALF_LIFE);

/** pnpm's, npm's, yarn's and bun's own commands: not a script's name. */
const PM_BUILTINS = new Set(["install", "i", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "exec", "dlx", "x", "create", "init", "link", "unlink", "publish", "pack", "outdated", "audit", "why", "list", "ls", "info", "view", "config", "store", "patch", "rebuild", "prune", "dedupe", "import", "env", "setup", "help", "version", "login", "logout", "whoami", "cache", "ci", "fund", "query", "pm", "workspace", "workspaces"]);

/** The package.json script a typed command runs ("pnpm dev", "npm run dev", "yarn dev" → dev), or null. */
export function scriptOf(command: string): string | null {
  const m = /^(npm|pnpm|yarn|bun)\s+(?:(run|run-script)\s+)?([\w:.@/-]+)$/.exec(command.trim().replace(/\s+/g, " "));
  if (!m) return null;
  if (!m[2] && (m[1] === "npm" || m[1] === "bun") && !["test", "start", "stop", "restart", "t"].includes(m[3]!)) return null;
  if (!m[2] && PM_BUILTINS.has(m[3]!)) return null;
  return m[3] === "t" ? "test" : m[3]!;
}

/** The same command however it was typed: spaces, a leading "./". */
export const normalize = (command: string) => command.trim().replace(/\s+/g, " ").replace(/^\.\//, "");

/** The action a typed command ran in `cwd`, or null. */
export function matchAction(actions: WorkspaceAction[], command: string, cwd: string): WorkspaceAction | null {
  const script = scriptOf(command);
  const norm = normalize(command);
  for (const a of actions) {
    if (path.resolve(a.cwd) !== path.resolve(cwd)) continue;
    if (script !== null && a.source.kind === "npm" && a.name === script) return a;
    if (normalize(a.command) === norm) return a;
  }
  return null;
}

/** Commands not worth a button: moving around, looking, editing, git, agents. */
const NOT_ACTIONS = /^(cd|ls|ll|la|l|pwd|clear|reset|exit|cat|bat|less|more|head|tail|grep|rg|ag|fd|find|tree|echo|printf|which|type|man|history|vi|vim|nvim|nano|emacs|code|cursor|zed|open|subl|git|gh|tig|lazygit|claude|codex|gemini|aider|cmd|rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|z|j|zoxide|export|source|\.|unset|alias|top|htop|btop|ps|kill|killall|pkill|sudo|brew|ssh|scp|curl|wget|ping|du|df|env|printenv|date|whoami|nvm|fnm|asdf|pyenv|source|exec|time|watch|jq|yq|sleep|true|false)$/;

export interface Ranked {
  /** Action id → decayed runs. */
  use: Map<string, number>;
  /** Commands run here often that match no action, best first. */
  history: WorkspaceAction[];
}

export function rank(actions: WorkspaceAction[], ran: Ran[], root: string, now = Date.now(), limit = 5): Ranked {
  const use = new Map<string, number>();
  const loose = new Map<string, { command: string; cwd: Map<string, number>; score: number; runs: number; failed: number }>();
  const under = (p: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  for (const r of ran) {
    if (!r.command || !under(r.cwd)) continue;
    const w = weight(r.at, now);
    const a = matchAction(actions, r.command, r.cwd);
    if (a) {
      use.set(a.id, (use.get(a.id) ?? 0) + w);
      continue;
    }
    const command = normalize(r.command);
    const first = command.split(" ")[0]!;
    if (command.includes("\n") || command.length > 200 || NOT_ACTIONS.test(first) || scriptOf(command) === null && /^(npm|pnpm|yarn|bun)$/.test(first) && PM_BUILTINS.has(command.split(" ")[1] ?? "")) continue;
    let l = loose.get(command);
    if (!l) loose.set(command, (l = { command, cwd: new Map(), score: 0, runs: 0, failed: 0 }));
    l.score += w;
    l.runs++;
    if (r.exitCode !== null && r.exitCode !== 0 && r.exitCode !== 130) l.failed++;
    l.cwd.set(r.cwd, (l.cwd.get(r.cwd) ?? 0) + 1);
  }
  const history = [...loose.values()]
    // Run at least three times, and mostly with success: a habit, not a typo.
    .filter((l) => l.runs >= 3 && l.failed * 2 < l.runs)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((l): WorkspaceAction => {
      const cwd = [...l.cwd].sort((a, b) => b[1] - a[1])[0]![0];
      const rel = path.relative(root, cwd);
      return { id: `history:${rel}:${l.command}`, name: l.command, command: l.command, cwd, source: { kind: "history", file: rel }, ...classify({ name: l.command.split(" ").slice(0, 3).join(" "), command: l.command, cwd, file: rel }), use: l.score, history: { runs: l.runs } };
    });
  return { use, history };
}
