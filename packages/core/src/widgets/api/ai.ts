// `cmd.ai.complete` (docs/56, "Secrets never reach a widget"): a completion from the person's
// AI through the core's AI service, no tools, the widget never holding a key. Text, or an object
// of the request's JSON Schema. Each package has a daily budget of tokens (widgets.aiBudget),
// counted in <state dir>/widget-packages/<name>/ai-usage.json; the call is logged as every AI
// call is (ai.call in the event log, purpose "widget:<name>").

import fs from "node:fs";
import path from "node:path";
import { widgetPackageData } from "@cmd/protocol/node";
import type { ApiCompletion, ApiCompletionRequest, WireValue } from "@cmd/protocol";
import { AiNotConfigured, type AiService } from "../../ai/service.ts";
import { failed, invalid } from "./access.ts";

const MAX_TOKENS = 4000;

export interface AiScope {
  /** The package's name. */
  name: string;
  stateDir: string | null;
  /** Tokens a package may use a day (0: no limit). */
  budget(): number;
  ai: Pick<AiService, "complete" | "object">;
}

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** Tokens a package used today, kept per instance (in memory without a state dir). */
export class AiUsage {
  #file: string | null;
  #mem = new Map<string, { day: string; tokens: number }>();
  constructor(stateDir: string | null) {
    this.#file = stateDir;
  }
  #path(name: string) {
    return this.#file ? path.join(widgetPackageData(this.#file, name), "ai-usage.json") : null;
  }
  used(name: string): number {
    const p = this.#path(name);
    let v = this.#mem.get(name);
    if (!v && p) {
      try {
        v = JSON.parse(fs.readFileSync(p, "utf8")) as { day: string; tokens: number };
      } catch {}
    }
    return v && v.day === today() ? v.tokens : 0;
  }
  add(name: string, tokens: number): void {
    const v = { day: today(), tokens: this.used(name) + tokens };
    this.#mem.set(name, v);
    const p = this.#path(name);
    if (!p) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(v) + "\n");
  }
}

export async function widgetComplete(req: ApiCompletionRequest, scope: AiScope, usage: AiUsage): Promise<ApiCompletion> {
  if (!req || typeof req !== "object" || typeof req.prompt !== "string" || !req.prompt.trim()) throw invalid("ai.complete: give it a prompt ({ prompt: \"…\" })");
  if (req.system !== undefined && typeof req.system !== "string") throw invalid("ai.complete: system should be text");
  if (req.schema !== undefined && (typeof req.schema !== "object" || req.schema === null || Array.isArray(req.schema))) throw invalid("ai.complete: schema should be a JSON Schema object");
  const budget = scope.budget();
  if (budget > 0 && usage.used(scope.name) >= budget) throw failed(`${scope.name} used today's AI budget (${budget.toLocaleString("en-US")} tokens). Raise it in Settings → Magic Widgets.`);
  const maxOutputTokens = Math.max(1, Math.min(Math.floor(Number(req.maxTokens) || MAX_TOKENS), MAX_TOKENS));
  const o = { tier: "fast" as const, purpose: `widget:${scope.name}`, background: true, prompt: req.prompt, ...(req.system ? { system: req.system } : {}), maxOutputTokens };
  try {
    if (req.schema) {
      const r = await scope.ai.object<WireValue>({ ...o, schema: req.schema as Record<string, unknown> });
      usage.add(scope.name, r.usage.input + r.usage.output);
      return { object: r.value, usage: { input: r.usage.input, output: r.usage.output } };
    }
    const r = await scope.ai.complete(o);
    usage.add(scope.name, r.usage.input + r.usage.output);
    return { text: r.value, usage: { input: r.usage.input, output: r.usage.output } };
  } catch (e) {
    if (e instanceof AiNotConfigured) throw failed("No AI provider is set up yet. Add an API key in Settings → AI.");
    throw failed(`ai.complete: ${(e as Error).message.slice(0, 300)}`);
  }
}
