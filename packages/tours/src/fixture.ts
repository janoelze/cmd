// The world a tour records in: a throwaway CMD_HOME (onboarding already seen),
// a home folder with a demo shell prompt and the files a tour shows, and an
// empty transcripts folder, so nothing of the person running it gets on video
// (their name and machine in the prompt, their sessions in Recent).

import fs from "node:fs";
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

/** The app's environment for a fixture. */
export function fixtureEnv(f: Fixture): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "ZDOTDIR" && k !== "CLAUDE_CONFIG_DIR") env[k] = v;
  return { ...env, HOME: f.home, CMD_HOME: f.cmdHome, CMD_TRANSCRIPTS_HOME: f.transcripts, CMD_USAGE_URL: "off", CMD_NO_SANDBOX: "1", CMD_BACKGROUND: "" };
}
