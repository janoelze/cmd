// Live Code's AI (docs/17-ai.md): turns a request ("drop the bass for a bar",
// "more swing") into the window's new code. The system prompt is prompt.md plus
// Strudel's function reference (reference.md, scripts/livecode-reference.mjs),
// the same on every call so providers cache it; the request carries the code,
// the sounds the window has loaded, and the last attempt's error when the
// window's frame refused it (renderer components/LiveCodeView.tsx retries).

import fs from "node:fs";
import path from "node:path";
import type { CompleteResult, ObjectRequest } from "../ai/backends.ts";
import type { CallOptions } from "../ai/service.ts";

const DIR = import.meta.dirname;

export interface ChangeRequest {
  code: string;
  request: string;
  /** Sound names the window has loaded (its frame's soundMap). */
  sounds?: string[];
  /** The last attempt at this request, and why it didn't play. */
  failed?: { code: string; error: string };
}

export interface ChangeAnswer {
  code: string;
  summary: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    code: { type: "string", description: "The whole new code." },
    summary: { type: "string", description: "What changed, in a few words." },
  },
  required: ["code", "summary"],
  additionalProperties: false,
};

let system: string | null = null;
/** prompt.md and the reference, read once (they ship with the core). */
export function changeSystem(): string {
  system ??= `${fs.readFileSync(path.join(DIR, "prompt.md"), "utf8").trim()}\n\n${fs.readFileSync(path.join(DIR, "reference.md"), "utf8").trim()}`;
  return system;
}

/** Sounds by bank, so a few hundred names stay short: "RolandTR909: bd cp hh …". */
export function soundList(sounds: string[]): string {
  const banks = new Map<string, string[]>();
  const plain: string[] = [];
  for (const s of sounds) {
    const i = s.lastIndexOf("_");
    if (i > 0) {
      const bank = s.slice(0, i);
      if (!banks.has(bank)) banks.set(bank, []);
      banks.get(bank)!.push(s.slice(i + 1));
    } else plain.push(s);
  }
  return [plain.join(" "), ...[...banks].map(([b, xs]) => `${b}: ${xs.join(" ")}`)].filter(Boolean).join("\n");
}

export function changePrompt(r: ChangeRequest): string {
  const parts = [`Request: ${r.request.trim()}`, `Code now playing:\n\`\`\`\n${r.code}\n\`\`\``];
  if (r.failed) parts.push(`Your last attempt didn't play:\n\`\`\`\n${r.failed.code}\n\`\`\`\nError: ${r.failed.error}`);
  if (r.sounds?.length) parts.push(`Loaded sounds (plain names, then banks with their sounds):\n${soundList(r.sounds)}`);
  return parts.join("\n\n");
}

type ObjectCall = <T>(o: CallOptions & ObjectRequest<T>) => Promise<CompleteResult<T>>;

export async function changeCode(object: ObjectCall, r: ChangeRequest, signal?: AbortSignal): Promise<ChangeAnswer> {
  if (!r.request.trim()) throw new Error("Say what to change");
  const res = await object<ChangeAnswer>({
    tier: "smart",
    purpose: "livecode.change",
    system: changeSystem(),
    cacheSystem: true,
    prompt: changePrompt(r),
    schema: SCHEMA,
    effort: "low",
    maxOutputTokens: 4000,
    signal,
  });
  const code = res.value.code.replace(/^```\w*\n([\s\S]*?)\n?```\s*$/, "$1");
  return { code, summary: res.value.summary.trim() };
}
