// API keys for development builds, so a fresh $CMD_HOME (a worktree's
// .cmd-dev, a `pnpm dist` build) has AI without a trip to Settings. Only the dev
// instance asks (main.ts); release builds read no keys from anywhere but
// secrets.json. A key set in Settings still wins, and removing it falls back here.
//
// Looked up, first found wins: the core's environment, then `.env` in this
// checkout, then `.env` in the main checkout (worktrees share the one file). A
// packaged dev build's core runs from the app's runtime folder, whose .checkout
// names the checkout it was built from (scripts/stage-runtime.mjs).
//   ANTHROPIC_API_KEY=sk-ant-…
//   OPENAI_API_KEY=sk-…
// CMD_DEV_KEYS=off turns it off (e2e, which checks the unconfigured app).

import fs from "node:fs";
import path from "node:path";
import { AI_PROVIDER_IDS, AI_PROVIDERS, type SecretKey } from "@cmd/protocol";
import type { DevKeys } from "./secrets.ts";

/** The variable each provider's key is read from. */
const VARS: Record<(typeof AI_PROVIDER_IDS)[number], string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };

/** KEY=value lines; quotes and `export ` allowed, # comments skipped. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/** This checkout, and the main checkout when this is a worktree (its .git is a file naming the main one's). */
export function checkouts(root: string): string[] {
  try {
    root = fs.readFileSync(path.join(root, ".checkout"), "utf8").trim() || root;
  } catch {}
  const dirs = [root];
  try {
    const git = fs.readFileSync(path.join(root, ".git"), "utf8").match(/^gitdir:\s*(.+)$/m)?.[1];
    const main = git?.match(/^(.*)\/\.git\/worktrees\/[^/]+\/?$/)?.[1];
    if (main) dirs.push(main);
  } catch {}
  return dirs;
}

/** Keys found for providers, with where each came from ("environment", "~/src/cmd/.env"). */
export function devKeys(root: string, env: NodeJS.ProcessEnv = process.env): DevKeys {
  const values: Partial<Record<SecretKey, string>> = {};
  const from: Partial<Record<SecretKey, string>> = {};
  if (env.CMD_DEV_KEYS === "off") return { values, from };
  const sources: [string, Record<string, string | undefined>][] = [["environment", env]];
  for (const dir of checkouts(root)) {
    try {
      sources.push([path.join(dir, ".env"), parseEnv(fs.readFileSync(path.join(dir, ".env"), "utf8"))]);
    } catch {}
  }
  for (const p of AI_PROVIDER_IDS) {
    const key = AI_PROVIDERS[p].keySecret as SecretKey;
    for (const [where, vars] of sources) {
      const v = vars[VARS[p]]?.trim();
      if (!v) continue;
      values[key] = v;
      from[key] = where;
      break;
    }
  }
  return { values, from };
}
