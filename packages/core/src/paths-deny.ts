// Private paths (docs/13-remote-access.md, "Scopes and the policy table"): files
// whose contents must never reach a model provider (Magic) or a paired device
// (remote). One list, so a credential file named here is out of reach of both.
// Remote also keeps cmd's own state and the agents' transcripts away
// (remotePrivatePaths); Magic can't, its widgets and Deno live in the state dir.

import os from "node:os";
import path from "node:path";
import { cmdHome, configDir } from "@cmd/protocol/node";

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

export function expandPath(p: string, home = os.homedir()): string {
  return p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

/** Is `p` (absolute) inside a denied path, or a .env file? */
export function isDeniedPath(p: string, deny: readonly string[], home = os.homedir(), cwd = home): boolean {
  const abs = path.resolve(cwd, expandPath(p, home));
  if (/^\.env(\..*)?$/.test(path.basename(abs))) return true;
  return deny.some((d) => {
    const root = path.resolve(expandPath(d, home));
    return abs === root || abs.startsWith(root + path.sep);
  });
}

/** Inside a worktree's own cmd instance (<worktree>/.cmd-dev, instance.ts worktreeHome)? */
export function inCmdInstance(p: string): boolean {
  return path.resolve(p).split(path.sep).includes(".cmd-dev");
}
