// What kind of action a found one is (docs/39, "What counts as an action"):
// from its name first, then from what it runs. The model may correct these
// later (describe.ts); without a provider these are all there is.

import type { ActionKind } from "@cmd/protocol";
import type { Found } from "./sources.ts";

/** Name → kind, checked in order; the name's words ("test:e2e" → test, e2e). */
const BY_NAME: [RegExp, ActionKind][] = [
  [/^(deploy|release|publish|ship|promote|rollout)$/, "deploy"],
  [/^(dev|start|serve|server|watch|preview|storybook|up)$/, "dev"],
  [/^(test|tests|spec|specs|e2e|integration|unit|coverage|bench|benchmark|cypress|playwright|vitest|jest)$/, "test"],
  [/^(build|compile|bundle|dist|package|pack|make|assemble|gen|generate|codegen)$/, "build"],
  [/^(lint|fmt|format|check|typecheck|types|tsc|clippy|vet|prettier|eslint|audit|validate|verify|ci)$/, "check"],
  [/^(clean|reset|purge|prune|nuke|down|stop)$/, "clean"],
  [/^(setup|install|bootstrap|init|migrate|migration|migrations|seed|db|prepare|deps|sync|update|upgrade)$/, "setup"],
];

/** What it runs → kind, when the name says nothing. */
const BY_SCRIPT: [RegExp, ActionKind][] = [
  [/\b(vercel|netlify|fly|wrangler|firebase)\s+deploy\b|\bnpm publish\b|\bgh release\b|\bdocker push\b/, "deploy"],
  [/\b(vite|next|nuxt|astro|remix|svelte-kit|webpack(-dev-server)?\s+serve|parcel|ng\s+serve|expo\s+start|rails\s+s(erver)?|uvicorn|gunicorn|flask\s+run|manage\.py\s+runserver|nodemon|tsx\s+watch|air|hugo\s+server|jekyll\s+serve)\b(?!\s+build)/, "dev"],
  [/\b(vitest|jest|mocha|ava|pytest|playwright\s+test|cypress\s+run|go\s+test|cargo\s+test|rspec|phpunit)\b/, "test"],
  [/\b(eslint|prettier|biome|tsc|ruff|black|mypy|flake8|stylelint|rubocop|golangci-lint|clippy)\b/, "check"],
  [/\b(tsc\s+-b|vite\s+build|next\s+build|webpack|rollup|esbuild|tsup|electron-builder|cargo\s+build|go\s+build)\b/, "build"],
  [/\brm\s+-rf?\b|\brimraf\b/, "clean"],
];

/** Runs until stopped: a server, a watcher, a REPL. */
const LONG = /(^|\s)(--watch|-w|watch|serve|--serve)(\s|$)|\b(vite(?!\s+build)|next\s+dev|nuxt\s+dev|astro\s+dev|remix\s+dev|webpack-dev-server|nodemon|tsx\s+watch|rails\s+s(erver)?|uvicorn|gunicorn|flask\s+run|runserver|docker\s+compose\s+up(?!.*\s-d\b)|storybook\s+dev|hugo\s+server|electron-vite\s+dev)\b/;
/** Drops, overwrites or ships something: confirm first. */
const RISKY_NAME = /(^|[:_-])(deploy|release|publish|ship|promote|rollout|drop|nuke|purge|destroy|reset|wipe)([:_-]|$)/;
const RISKY_SCRIPT = /\bnpm\s+publish\b|\bgh\s+release\b|\bgit\s+push\b|\bdocker\s+push\b|\bterraform\s+(apply|destroy)\b|\bkubectl\s+(apply|delete)\b|\b(drop|truncate)\s+(table|database)\b|\bdb:(drop|reset)\b|--force\b/i;

const words = (name: string) => name.toLowerCase().split(/[\s:._/-]+/).filter(Boolean);

export function classify(f: Found): { kind: ActionKind; long: boolean; risky: boolean } {
  const ws = words(f.name);
  const script = f.script ?? f.command;
  let kind = (f.kind as ActionKind | undefined) ?? null;
  // Agent skills are what they are, whatever they're called ("/release" asks the agent; the skill decides).
  if (kind === "agent") return { kind, long: true, risky: false };
  // The first word decides ("test:watch" is a test), then the others ("db:migrate" is setup).
  for (const w of ws) {
    if (kind) break;
    kind = BY_NAME.find(([re]) => re.test(w))?.[1] ?? null;
  }
  kind ??= BY_SCRIPT.find(([re]) => re.test(script))?.[1] ?? "run";
  const long = f.long ?? (LONG.test(script) || ws.includes("watch") || ws[0] === "logs" || (kind === "dev" && /^(dev|start|serve|server|preview|storybook)$/.test(ws[0] ?? "") && !/\bbuild\b/.test(script)));
  const risky = f.risky ?? (kind === "deploy" || RISKY_NAME.test(f.name.toLowerCase()) || RISKY_SCRIPT.test(script));
  return { kind, long: !!long, risky: !!risky };
}
