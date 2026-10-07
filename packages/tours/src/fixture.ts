// The world a tour records in: a throwaway CMD_HOME (onboarding already seen),
// a home folder with a demo shell prompt and the files a tour shows, and an
// empty transcripts folder, so nothing of the person running it gets on video
// (their name and machine in the prompt, their sessions in Recent).

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
  const f: Fixture = { cmdHome: dir, home: path.join(dir, "home"), transcripts: path.join(dir, "transcripts") };
  for (const d of [path.join(dir, "ui"), f.home, f.transcripts]) fs.mkdirSync(d, { recursive: true });
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
export function addAiKeys(f: Fixture): string {
  const keys = findAiKeys();
  if (!Object.keys(keys).length) throw new Error("this tour needs an AI key: set ANTHROPIC_API_KEY (or OPENAI_API_KEY) in the environment or in ~/.secrets");
  const secrets = path.join(f.cmdHome, "secrets.json");
  fs.writeFileSync(secrets, JSON.stringify(keys), { mode: 0o600 });
  const settingsFile = path.join(f.cmdHome, "settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
  settings["ai.provider"] ??= keys["ai.anthropic.apiKey"] ? "anthropic" : "openai";
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  return secrets;
}

/** The app's environment for a fixture. */
export function fixtureEnv(f: Fixture): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ZDOTDIR" && k !== "CLAUDE_CONFIG_DIR") env[k] = v;
  return { ...env, HOME: f.home, CMD_HOME: f.cmdHome, CMD_TRANSCRIPTS_HOME: f.transcripts, CMD_USAGE_URL: "off", CMD_NO_SANDBOX: "1", CMD_BACKGROUND: "" };
}
