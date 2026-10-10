// Private paths (docs/13-remote-access.md, "Scopes and the policy table"): files
// whose contents must never reach a model provider (Magic) or a paired device
// (remote). One list, so a credential file named here is out of reach of both.
// Remote also keeps cmd's own state and the agents' transcripts away
// (remotePrivatePaths); Magic can't, its widgets and Deno live in the state dir,
// so it is denied the files in there instead (magicPrivatePaths).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdHome, configDir, logDir } from "@cmd/protocol/node";

/** Paths whose contents stay on this Mac. `~` is the home folder. */
export const DEFAULT_DENY_PATHS = [
  "~/.ssh",
  "~/.aws",
  "~/.azure",
  "~/.config/gcloud",
  "~/.kube",
  "~/.gnupg",
  "~/.netrc",
  "~/.npmrc",
  "~/.pypirc",
  "~/.git-credentials",
  "~/.docker/config.json",
  "~/.password-store",
  "~/.config/op",
  // Tokens of CLIs (Magic's gh and glab get theirs back through CREDENTIALED).
  "~/.config/gh",
  "~/.config/glab-cli",
  "~/Library/Application Support/glab-cli",
  "~/.config/hub",
  "~/.yarnrc.yml",
  "~/.cargo/credentials",
  "~/.cargo/credentials.toml",
  "~/.gem/credentials",
  "~/.terraform.d/credentials.tfrc.json",
  "~/.vault-token",
  "~/.pgpass",
  "~/.my.cnf",
  "~/.config/doctl",
  "~/.config/heroku",
  "~/.netlify",
  "~/.config/netlify",
  "~/.vercel",
  "~/.fly",
  "~/.config/configstore",
  // Shell and REPL histories: pasted tokens, passwords in commands.
  "~/.zsh_history",
  "~/.zhistory",
  "~/.zsh_sessions",
  "~/.bash_history",
  "~/.bash_sessions",
  "~/.sh_history",
  "~/.local/share/fish/fish_history",
  "~/.python_history",
  "~/.node_repl_history",
  "~/.psql_history",
  "~/.mysql_history",
  "~/.sqlite_history",
  "~/.irb_history",
  "~/Library/Keychains",
  "~/Library/Cookies",
  "~/Library/Safari",
  "~/Library/Messages",
  "~/Library/Mail",
  "~/Library/Application Support/Google/Chrome",
  "~/Library/Application Support/Chromium",
  "~/Library/Application Support/Firefox",
  "~/Library/Application Support/BraveSoftware",
  "~/Library/Application Support/Arc",
];

/** Where coding agents keep config, logins and transcripts by default (agents/homes.ts finds the rest). */
export const AGENT_HOME_PATHS = ["~/.claude", "~/.claude.json", "~/.config/claude", "~/.codex", "~/.gemini", "~/.qwen", "~/.copilot"];

/**
 * cmd's own state, config and logs, for every instance: the host key and relay
 * secret, secrets.json, settings, the event log. The release and dev folders,
 * this instance's ($CMD_HOME, $CMD_CONFIG_DIR) and, by name, worktree instances
 * (.cmd-dev, see isDeniedPath).
 */
export function cmdPrivatePaths(): string[] {
  const out = new Set(["~/.config/cmd"]);
  for (const d of ["cmd", "cmd-dev"]) {
    out.add(`~/Library/Application Support/${d}`);
    out.add(`~/Library/Logs/${d}`);
  }
  out.add(cmdHome());
  out.add(configDir());
  return [...out];
}

/** Everything a paired device may never read: the default list, cmd's state, agents' homes. */
export function remotePrivatePaths(): string[] {
  return [...DEFAULT_DENY_PATHS, ...AGENT_HOME_PATHS, ...cmdPrivatePaths()];
}

/**
 * What in an instance's state dir holds secrets or the user's data: API keys,
 * widget secrets, the host key and relay secret (remote/), settings, the
 * database and event log, histories, summaries, logs, the UI's web storage.
 * Everything else (widgets/, runtime/ with Deno and its cache, bin/, hooks/)
 * stays readable, because Magic builds and runs widgets there.
 */
export const INSTANCE_PRIVATE_FILES = [
  "secrets.json",
  "widget-secrets.json",
  "ai-models.json",
  "remote",
  "settings.json",
  "keybindings.json",
  "cmd.sqlite",
  "cmd.sqlite-wal",
  "cmd.sqlite-shm",
  "cmd.sqlite-journal",
  "data",
  "history",
  "summaries",
  "logs",
  "ui",
  "machine-id",
  "core.log",
  "update.log",
];

/**
 * cmd's own secrets for Magic, which can't be denied whole state dirs: the
 * private files of every instance's state dir (release, dev, $CMD_HOME), the
 * config dir (whole, unless it is a state dir) and the logs. Worktree instances
 * elsewhere are caught by name (isDeniedPath, inInstancePrivate).
 */
export function magicPrivatePaths(): string[] {
  const home = os.homedir();
  const out = new Set(["~/.config/cmd", logDir()]);
  const states = new Set([cmdHome()]);
  for (const d of ["cmd", "cmd-dev"]) {
    states.add(path.join(home, "Library", "Application Support", d));
    out.add(`~/Library/Logs/${d}`);
  }
  for (const s of states) for (const f of INSTANCE_PRIVATE_FILES) out.add(path.join(s, f));
  const config = path.resolve(expandPath(configDir(), home));
  if (![...states].some((s) => path.resolve(s) === config)) out.add(config);
  return [...out];
}

/** Everything Magic's tools, command sources and widget runs may never read: the default list and cmd's secrets. */
export function magicDenyPaths(): string[] {
  return [...DEFAULT_DENY_PATHS, ...magicPrivatePaths()];
}

/** A regex (POSIX ERE, also the sandbox profile's) for a private file inside any worktree instance (<worktree>/.cmd-dev/secrets.json, …). */
export const INSTANCE_PRIVATE_PATTERN = `/\\.cmd-dev/(${INSTANCE_PRIVATE_FILES.map((f) => f.replace(/[.]/g, "\\.")).join("|")})(/|$)`;
const INSTANCE_PRIVATE_RE = new RegExp(INSTANCE_PRIVATE_PATTERN);

/** Inside a private file of a worktree's cmd instance? */
export function inInstancePrivate(p: string): boolean {
  return INSTANCE_PRIVATE_RE.test(path.resolve(p).split(path.sep).join("/"));
}

/** The real path of `p`, also when it doesn't exist yet (its nearest existing folder resolved: /var is /private/var). */
export function realPathOf(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(realPathOf(parent), path.basename(abs));
  }
}

/** Is `p` private, as written or as its real path (symlinks), against each denied path as written and real? */
export function isPrivatePath(p: string, deny: readonly string[], home = os.homedir(), cwd = home): boolean {
  const abs = path.resolve(cwd, expandPath(p, home));
  const all = deny.flatMap((d) => {
    const e = path.resolve(expandPath(d, home));
    const r = realPathOf(e);
    return r === e ? [e] : [e, r];
  });
  return isDeniedPath(abs, all, home) || isDeniedPath(realPathOf(abs), all, home);
}

export function expandPath(p: string, home = os.homedir()): string {
  return p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

/** Is `p` (absolute) inside a denied path, a .env file, or a worktree instance's private file? */
export function isDeniedPath(p: string, deny: readonly string[], home = os.homedir(), cwd = home): boolean {
  const abs = path.resolve(cwd, expandPath(p, home));
  if (/^\.env(\..*)?$/.test(path.basename(abs))) return true;
  if (inInstancePrivate(abs)) return true;
  return deny.some((d) => {
    const root = path.resolve(expandPath(d, home));
    return abs === root || abs.startsWith(root + path.sep);
  });
}

/** Inside a worktree's own cmd instance (<worktree>/.cmd-dev, instance.ts worktreeHome)? */
export function inCmdInstance(p: string): boolean {
  return path.resolve(p).split(path.sep).includes(".cmd-dev");
}
