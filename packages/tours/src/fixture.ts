// The world a tour records in: a throwaway CMD_HOME (onboarding already seen)
// and a home folder with a demo shell prompt, the files a tour shows and its own
// ~/.claude (transcripts for Recent), so nothing of the person running it gets
// on video (their name and machine in the prompt, their sessions in Recent).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Fixture {
  /** CMD_HOME: the core's socket, database, settings and logs. */
  cmdHome: string;
  /** HOME for the app and its shells. */
  home: string;
  transcripts: string;
}

/** A fresh fixture under `dir`; `files` are written into the home folder (path → content). */
export function makeFixture(dir: string, files: Record<string, string> = {}, settings: Record<string, unknown> = {}): Fixture {
  fs.rmSync(dir, { recursive: true, force: true });
  // One home for everything: the app, the shells, and the transcripts (its ~/.claude), as on a real Mac;
  // the core finds agent homes (and their hooks) under the transcripts home.
  const home = path.join(dir, "home");
  const f: Fixture = { cmdHome: dir, home, transcripts: home };
  for (const d of [path.join(dir, "ui"), home, path.join(home, ".claude", "projects")]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "ui", "onboarding.json"), JSON.stringify({ seen: ["welcome", "ai"] }));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  // A short prompt: the folder, then ❯. No user or machine name.
  fs.writeFileSync(path.join(f.home, ".zshrc"), "PROMPT='%F{blue}%~%f %F{magenta}❯%f '\nunsetopt PROMPT_SP\n");
  for (const [p, content] of Object.entries(files)) {
    const full = path.join(f.home, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (p.endsWith("/")) fs.mkdirSync(full, { recursive: true });
    else fs.writeFileSync(full, content);
  }
  return f;
}

/** Provider keys by cmd secret name, and where they come from: the environment first, then ~/.secrets (`export NAME=value` lines). */
const KEY_SOURCES: Record<string, string[]> = {
  "ai.anthropic.apiKey": ["ANTHROPIC_API_KEY"],
  "ai.openai.apiKey": ["OPENAI_API_KEY", "OPENAI_KEY"],
};

/**
 * The person's AI keys, for tours that need a model (a Magic build). Never
 * logged; written only into the fixture's secrets.json, which the runner
 * deletes after the run.
 */
export function findAiKeys(): Record<string, string> {
  const file: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(path.join(os.homedir(), ".secrets"), "utf8").split("\n")) {
      const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) file[m[1]!] = m[2]!.trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {}
  const keys: Record<string, string> = {};
  for (const [secret, names] of Object.entries(KEY_SOURCES)) {
    const v = names.map((n) => process.env[n] || file[n]).find((x) => x && x.length > 10);
    if (v) keys[secret] = v;
  }
  return keys;
}

/** Gives a fixture the person's AI keys and picks the provider (Anthropic if there's a key for it). */
export function addAiKeys(f: Fixture): { secrets: string; env: Record<string, string> } {
  const keys = findAiKeys();
  if (!Object.keys(keys).length) throw new Error("this tour needs an AI key: set ANTHROPIC_API_KEY (or OPENAI_API_KEY) in the environment or in ~/.secrets");
  const secrets = path.join(f.cmdHome, "secrets.json");
  fs.writeFileSync(secrets, JSON.stringify(keys), { mode: 0o600 });
  const settingsFile = path.join(f.cmdHome, "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
  settings["ai.provider"] ??= keys["ai.anthropic.apiKey"] ? "anthropic" : "openai";
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const anthropic = keys["ai.anthropic.apiKey"];
  if (anthropic) setUpClaudeCode(f, anthropic);
  // Terminals inherit it, so Claude Code in a tour runs on the key (never written to disk outside secrets.json).
  return { secrets, env: anthropic ? { ANTHROPIC_API_KEY: anthropic } : {} };
}

/**
 * Claude Code in the fixture's home, past its first-run screens: onboarding
 * done, the key approved (Claude Code remembers its last 20 characters), every
 * folder under ~/src trusted, Sonnet (quicker than Opus for a demo).
 * cmd's hook goes into ~/.claude/settings.json at run time (run.ts).
 */
function setUpClaudeCode(f: Fixture, key: string) {
  const projects: Record<string, unknown> = {};
  const src = path.join(f.home, "src");
  for (const d of fs.existsSync(src) ? fs.readdirSync(src) : []) projects[path.join(src, d)] = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] };
  projects[f.home] = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] };
  fs.writeFileSync(
    path.join(f.home, ".claude.json"),
    JSON.stringify({ hasCompletedOnboarding: true, hasSeenAutoDefaultNotice: true, hasSeenAutoModeEntryWarning: true, theme: "dark", numStartups: 12, autoUpdates: false, customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] }, projects }, null, 1),
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(f.home, ".claude", "settings.json"), JSON.stringify({ model: "sonnet" }, null, 1));
}

/**
 * Variables of the session running the tour that must not reach the app: the
 * agent it runs in (Claude Code's markers make the tour's Claude Code think it's
 * a child session), the cmd pane it runs in (hooks would report to that cmd),
 * terminal and shell settings.
 */
const LEAKS = /^(ZDOTDIR|CLAUDECODE|CLAUDE_|AI_AGENT|CMD_|CODEX_|GHOSTTY_|TERM_PROGRAM|ITERM_|VSCODE_|CURSOR_|__CF)/;

/** The app's environment for a fixture. */
export function fixtureEnv(f: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !LEAKS.test(k)) env[k] = v;
  delete env.ANTHROPIC_API_KEY;
  return { ...env, ...extra, HOME: f.home, CMD_HOME: f.cmdHome, CMD_TRANSCRIPTS_HOME: f.transcripts, CMD_USAGE_URL: "off", CMD_NO_SANDBOX: "1", CMD_BACKGROUND: "" };
}
