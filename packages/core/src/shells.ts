// How each shell is started with cmd's shell integration (shell/<name>), without
// skipping the user's own startup files:
//  - zsh: ZDOTDIR points at shell/zsh, whose .zshenv restores the user's ZDOTDIR.
//  - bash: --posix with ENV pointing at our script, which leaves POSIX mode and
//    sources the usual files. Apple's /bin/bash 3.2 ignores ENV there, so it
//    gets --rcfile instead (a login shell is then emulated by the script).
//  - fish: shell/ first in XDG_DATA_DIRS, so fish sources
//    shell/fish/vendor_conf.d; the script puts XDG_DATA_DIRS back.

import fs from "node:fs";
import path from "node:path";

const SHELL_DIR = path.resolve(import.meta.dirname, "../shell");
/** zsh integration (shell/zsh): .zshenv restores the user's ZDOTDIR, then adds hooks. */
export const ZSH_INTEGRATION_DIR = path.join(SHELL_DIR, "zsh");
export const BASH_INTEGRATION_SCRIPT = path.join(SHELL_DIR, "bash", "cmd-integration.bash");
/** Goes first in XDG_DATA_DIRS: fish reads <dir>/fish/vendor_conf.d. */
export const FISH_INTEGRATION_DATA_DIR = SHELL_DIR;
const FISH_SCRIPT = path.join(SHELL_DIR, "fish", "vendor_conf.d", "cmd-integration.fish");

export type IntegratedShell = "zsh" | "bash" | "fish";

/** "zsh" for /bin/zsh, "pwsh" for C:\\…\\pwsh.exe. */
export const shellName = (shell: string) => path.basename(shell.replace(/\\/g, "/")).replace(/\.exe$/i, "");

/** Apple's bash 3.2 (SIP keeps /bin as shipped); a bare "bash" is looked up in PATH. */
function isAppleBash(shell: string, env: Record<string, string>): boolean {
  if (process.platform !== "darwin") return false;
  if (!shell.includes("/")) shell = (env.PATH ?? "").split(":").map((d) => path.join(d, shell)).find((p) => fs.existsSync(p)) ?? shell;
  try {
    return fs.realpathSync(shell) === "/bin/bash";
  } catch {
    return false;
  }
}

/**
 * Set up `env` for the shell's integration and return the arguments to start it
 * with; null if there is none for this shell (env untouched).
 */
export function integrate(shell: string, login: boolean, env: Record<string, string>): { kind: IntegratedShell; args: string[] } | null {
  const name = shellName(shell);
  if (name === "zsh" && fs.existsSync(ZSH_INTEGRATION_DIR)) {
    if (env.ZDOTDIR !== undefined) env.CMD_USER_ZDOTDIR = env.ZDOTDIR;
    env.ZDOTDIR = ZSH_INTEGRATION_DIR;
    return { kind: "zsh", args: login ? ["-l"] : [] };
  }
  if (name === "bash" && fs.existsSync(BASH_INTEGRATION_SCRIPT)) {
    if (isAppleBash(shell, env)) {
      env.CMD_BASH_INJECT = login ? "rcfile login" : "rcfile";
      return { kind: "bash", args: ["--rcfile", BASH_INTEGRATION_SCRIPT] };
    }
    if (env.ENV !== undefined) env.CMD_USER_ENV = env.ENV;
    env.ENV = BASH_INTEGRATION_SCRIPT;
    env.CMD_BASH_INJECT = "posix";
    // POSIX mode's default history file is ~/.sh_history.
    if (env.HISTFILE === undefined && env.HOME) {
      env.HISTFILE = path.join(env.HOME, ".bash_history");
      env.CMD_BASH_UNEXPORT_HISTFILE = "1";
    }
    return { kind: "bash", args: login ? ["--posix", "-l"] : ["--posix"] };
  }
  if (name === "fish" && fs.existsSync(FISH_SCRIPT)) {
    if (env.XDG_DATA_DIRS !== undefined) env.CMD_USER_XDG_DATA_DIRS = env.XDG_DATA_DIRS;
    // Unset means /usr/local/share:/usr/share (XDG base dir spec), which fish reads then.
    env.XDG_DATA_DIRS = [FISH_INTEGRATION_DATA_DIR, env.XDG_DATA_DIRS || "/usr/local/share:/usr/share"].join(":");
    env.CMD_FISH_INJECT = "1";
    return { kind: "fish", args: login ? ["-l"] : [] };
  }
  return null;
}
