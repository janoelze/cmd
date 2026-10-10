// Shell integration (shells.ts, shell/): how each shell is started, then real
// zsh, bash and fish (those installed) reporting to the core through it, with
// the user's own startup files still loaded. CMD_TEST_FISH names a fish binary.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OscEvent } from "../src/osc.ts";
import { Core } from "../src/core.ts";
import { nodePtyFactory } from "../src/panes.ts";
import { BASH_INTEGRATION_SCRIPT, FISH_INTEGRATION_DATA_DIR, ZSH_INTEGRATION_DIR, integrate } from "../src/shells.ts";
import { rmTemp } from "./tmp.ts";
import { needs, until } from "../../../test/system.ts";

const mac = process.platform === "darwin";

describe("starting a shell with its integration", () => {
  it("zsh: ZDOTDIR, keeping the user's", () => {
    const env: Record<string, string> = { ZDOTDIR: "/u/zdot" };
    expect(integrate("/bin/zsh", true, env)).toEqual({ kind: "zsh", args: ["-l"] });
    expect(env).toMatchObject({ ZDOTDIR: ZSH_INTEGRATION_DIR, CMD_USER_ZDOTDIR: "/u/zdot" });
  });

  it("bash: POSIX mode and ENV, keeping the user's ENV and ~/.bash_history", () => {
    const env: Record<string, string> = { HOME: "/home/u", ENV: "/u/env.sh" };
    expect(integrate("/usr/local/opt/bash/bin/bash", true, env)).toEqual({ kind: "bash", args: ["--posix", "-l"] });
    expect(env).toMatchObject({ ENV: BASH_INTEGRATION_SCRIPT, CMD_USER_ENV: "/u/env.sh", CMD_BASH_INJECT: "posix", HISTFILE: "/home/u/.bash_history", CMD_BASH_UNEXPORT_HISTFILE: "1" });
    const own: Record<string, string> = { HOME: "/home/u", HISTFILE: "/u/hist" };
    expect(integrate("/usr/local/opt/bash/bin/bash", false, own)!.args).toEqual(["--posix"]);
    expect(own.HISTFILE).toBe("/u/hist");
    expect(own.CMD_BASH_UNEXPORT_HISTFILE).toBeUndefined();
    expect(own.CMD_USER_ENV).toBeUndefined();
  });

  it.runIf(mac && fs.existsSync("/bin/bash"))("Apple's /bin/bash: --rcfile, which ignores ENV in POSIX mode", () => {
    const env: Record<string, string> = { HOME: "/home/u" };
    expect(integrate("/bin/bash", true, env)).toEqual({ kind: "bash", args: ["--rcfile", BASH_INTEGRATION_SCRIPT] });
    expect(env).toEqual({ HOME: "/home/u", CMD_BASH_INJECT: "rcfile login" });
    expect(integrate("bash", false, { PATH: "/nowhere:/bin" })!.args[0]).toBe("--rcfile");
  });

  it("fish: our folder first in XDG_DATA_DIRS, the user's value kept to restore", () => {
    const env: Record<string, string> = { XDG_DATA_DIRS: "/a:/b" };
    expect(integrate("/opt/homebrew/bin/fish", true, env)).toEqual({ kind: "fish", args: ["-l"] });
    expect(env).toEqual({ XDG_DATA_DIRS: `${FISH_INTEGRATION_DATA_DIR}:/a:/b`, CMD_USER_XDG_DATA_DIRS: "/a:/b", CMD_FISH_INJECT: "1" });
    // Unset: the XDG default stays readable, and the script unsets it again.
    const unset: Record<string, string> = {};
    integrate("fish", false, unset);
    expect(unset.XDG_DATA_DIRS).toBe(`${FISH_INTEGRATION_DATA_DIR}:/usr/local/share:/usr/share`);
    expect(unset.CMD_USER_XDG_DATA_DIRS).toBeUndefined();
  });

  it("other shells: none", () => {
    const env = {};
    expect(integrate("/bin/sh", true, env)).toBeNull();
    expect(integrate("pwsh.exe", false, env)).toBeNull();
    expect(env).toEqual({});
  });
});

/** The installed shells to try for real. */
function shells(): string[] {
  if (process.platform === "win32") return [];
  const inPath = (name: string) => (process.env.PATH ?? "").split(":").map((d) => path.join(d, name)).find((p) => fs.existsSync(p));
  const found = ["/bin/zsh", "/bin/bash", inPath("bash"), "/opt/homebrew/bin/bash", process.env.CMD_TEST_FISH, inPath("fish")];
  const seen = new Set<string>();
  return found.filter((s): s is string => {
    if (!s || !fs.existsSync(s)) return false;
    const real = fs.realpathSync(s);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

/** Folders whose names a cwd report has to survive, the same for every shell (OSC 7: #, ?, %, spaces, UTF-8). */
const CWD_FIXTURES = ["a#b", "c?d", "50%off", "ü ñ", "two words"];

describe("shells to test", () => {
  const names = new Set(shells().map((s) => path.basename(s)));
  // CI has zsh and bash; fish only where someone installed it (CMD_TEST_FISH names one).
  for (const name of ["zsh", "bash", "fish"]) if (needs(names.has(name), name, { optional: name === "fish" })) it.skip(`${name} isn't installed, so its integration isn't tested`, () => {});
});

describe.each(shells())("%s with cmd's integration", (shell) => {
  const name = path.basename(shell);
  let dir: string;
  let home: string;
  let core: Core;
  const saved = { HOME: process.env.HOME, ZDOTDIR: process.env.ZDOTDIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, HISTFILE: process.env.HISTFILE, ENV: process.env.ENV };

  beforeAll(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-shell-")));
    // A home of our own, with startup files that say they ran.
    home = path.join(dir, "home");
    fs.mkdirSync(path.join(home, ".config", "fish"), { recursive: true });
    fs.writeFileSync(path.join(home, ".bashrc"), "echo RC-LOADED\n");
    fs.writeFileSync(path.join(home, ".bash_profile"), "echo PROFILE-LOADED; . ~/.bashrc\n");
    fs.writeFileSync(path.join(home, ".zshrc"), "echo RC-LOADED\n");
    fs.writeFileSync(path.join(home, ".zprofile"), "echo PROFILE-LOADED\n");
    fs.writeFileSync(path.join(home, ".config", "fish", "config.fish"), "set -g fish_greeting\necho RC-LOADED\n");
    process.env.HOME = home;
    for (const k of ["ZDOTDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "HISTFILE", "ENV"] as const) delete process.env[k];
    process.env.BASH_SILENCE_DEPRECATION_WARNING = "1";
    core = new Core({ socketPath: path.join(dir, "core.sock"), dbPath: null, settingsPath: null, terminals: await nodePtyFactory(), pollMs: 0, stateDir: dir, home: dir });
    core.settings.set("shell.program", shell);
  });

  afterAll(async () => {
    await core?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmTemp(dir);
  });

  /** A pane, and what its shell reported. fish 4 waits for a terminal's DA1 answer, which a UI would give. */
  function start(opts: Parameters<Core["panes"]["create"]>[0] = {}) {
    const pane = core.panes.create({ cwd: home, ...opts });
    const r = { id: pane.id, out: "", osc: [] as OscEvent[], requests: [] as [string, string][] };
    core.panes.on("output", (id, data) => {
      if (id !== pane.id) return;
      r.out += data;
      if (data.includes("\x1b[0c") || data.includes("\x1b[c")) core.panes.write(id, "\x1b[?62;22c");
    });
    core.panes.on("osc", (id, ev) => void (id === pane.id && r.osc.push(ev)));
    core.panes.on("request", (id, action, arg) => void (id === pane.id && r.requests.push([action, arg])));
    return r;
  }
  const prompts = (r: ReturnType<typeof start>) => r.osc.filter((e) => e.type === "prompt" && e.mark === "A").length;

  it("loads the user's config, reports cwd, prompt marks and the running command, and opens files in cmd", async () => {
    const sub = path.join(home, "a b");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "note.txt"), "hello\n");
    const r = start();
    await until("the first prompt", () => prompts(r) > 0);
    expect(r.out).toContain("RC-LOADED");
    // A login shell (shell.login) reads the profile; fish has just one config.
    if (name !== "fish") expect(r.out).toContain("PROFILE-LOADED");

    core.panes.write(r.id, `cd "a b"\r`);
    await until("the cwd", () => core.panes.get(r.id)?.cwd === sub);

    core.panes.write(r.id, "sleep 1\r");
    await until("the running command", () => core.panes.command(r.id) === "sleep 1");
    await until("the command's end", () => core.panes.command(r.id) === null);

    // Waits for the exit status itself: counting prompts raced the prompt after `sleep 1`,
    // which can arrive after its D mark, so it was taken for the prompt after `false`.
    core.panes.write(r.id, "false\r");
    await until("false's exit status", () => r.osc.some((e) => e.type === "prompt" && e.mark === "D" && e.exitCode === 1));
    expect(r.osc).toContainEqual({ type: "prompt", mark: "C" });

    core.panes.write(r.id, "open note.txt\r");
    await until("the open request", () => r.requests.length > 0);
    expect(r.requests[0]).toEqual(["open", path.join(sub, "note.txt")]);

    // Each terminal's own history, next to the user's (fish has none).
    if (name !== "fish") {
      const hist = fs.readFileSync(path.join(dir, "history", `${r.id}.${name === "zsh" ? "zsh" : "bash"}_history`), "utf8");
      expect(hist).toContain("sleep 1");
    }
    core.panes.kill(r.id);
  });

  it("reports folders with #, ?, %, spaces and non-ASCII in their names exactly", async () => {
    const base = path.join(home, "cwds");
    for (const f of CWD_FIXTURES) fs.mkdirSync(path.join(base, f), { recursive: true });
    const r = start({ cwd: base });
    await until("the first prompt", () => prompts(r) > 0);
    for (const f of CWD_FIXTURES) {
      const want = path.join(base, f);
      core.panes.write(r.id, `cd '${want}'\r`);
      await until(`the cwd ${f}`, () => core.panes.get(r.id)?.cwd === want).catch((e) => {
        throw new Error(`${e.message} (pane says ${JSON.stringify(core.panes.get(r.id)?.cwd)})`);
      });
    }
    core.panes.kill(r.id);
  });

  it("offers the command that was running before a restart", async () => {
    const r = start({ env: { CMD_RESTORE_COMMAND: "echo restored | tr a-z A-Z" } });
    await until("the first prompt", () => prompts(r) > 0);
    await new Promise((res) => setTimeout(res, 300));
    // zsh and fish put it on the command line; bash in history.
    core.panes.write(r.id, name === "bash" ? "\x1b[A\r" : "\r");
    await until("the restored command to run", () => r.out.includes("RESTORED"));
    core.panes.kill(r.id);
  });

  it.runIf(name === "bash")("loads the terminal's history from before a restart", async () => {
    const id = "restored-pane";
    fs.mkdirSync(path.join(dir, "history"), { recursive: true });
    fs.writeFileSync(path.join(dir, "history", `${id}.bash_history`), "echo from-history | tr a-z A-Z\n");
    const r = start({ id });
    await until("the first prompt", () => prompts(r) > 0);
    await new Promise((res) => setTimeout(res, 300));
    core.panes.write(r.id, "\x1b[A\r");
    await until("the command from history to run", () => r.out.includes("FROM-HISTORY"));
    core.panes.kill(r.id);
  });
});
