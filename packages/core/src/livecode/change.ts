// Live Code's AI (docs/17-ai.md): turns a request ("drop the bass for a bar",
// "more swing") into the window's new code. The system prompt is prompt.md, a
// sound guide, a genre cookbook and Strudel's function reference (reference.md,
// scripts/livecode-reference.mjs), the same on every call so providers cache it;
// the request carries the code, the sounds the window has loaded, and the last attempt's error when the
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
  /** The code before each earlier change, newest first, with the request and what changed. */
  history?: { code: string; request: string; summary: string }[];
  /** The last attempt at this request, and why it didn't play. */
  failed?: { code: string; error: string };
}

export interface ChangeAnswer {
  code: string;
  summary: string;
}

/** One replacement in the code: `find` must occur in it exactly once. */
export interface Edit {
  find: string;
  replace: string;
}

/** What the model returns: edits to the code (most changes), or the whole code (a new piece). */
interface ModelAnswer {
  summary: string;
  edits: Edit[];
  code: string;
}

// Every field required (strict structured output): edits leave `code` empty, a rewrite leaves `edits` empty.
const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "What changed, in a few words." },
    edits: {
      type: "array",
      description: "Replacements in the code now playing, applied in order. Empty when `code` has the whole new code.",
      items: {
        type: "object",
        properties: {
          find: { type: "string", description: "An exact snippet of the current code that occurs once." },
          replace: { type: "string", description: "What it becomes." },
        },
        required: ["find", "replace"],
        additionalProperties: false,
      },
    },
    code: { type: "string", description: "The whole new code, only for a new piece or a change to most of it; else empty." },
  },
  required: ["summary", "edits", "code"],
  additionalProperties: false,
};

/** The code after `edits`; throws, naming the edit, when a `find` is missing or not unique. */
export function applyEdits(code: string, edits: Edit[]): string {
  let out = code;
  edits.forEach((e, i) => {
    const at = e.find ? out.indexOf(e.find) : -1;
    const which = `Edit ${i + 1} (find ${JSON.stringify(e.find.length > 60 ? e.find.slice(0, 60) + "…" : e.find)})`;
    if (at < 0) throw new Error(`${which}: not in the code`);
    if (out.indexOf(e.find, at + 1) >= 0) throw new Error(`${which}: occurs more than once; include more of the line`);
    out = out.slice(0, at) + e.replace + out.slice(at + e.find.length);
  });
  return out;
}

let system: string | null = null;
/**
 * The system prompt, read once (the files ship with the core): how to answer
 * (prompt.md), what the important sounds are (sounds.md), how to make them
 * sound good (sound-design.md: mixing rules and patches), genre starting points
 * written for this app (cookbook.md), and every function (reference.md).
 */
export function changeSystem(): string {
  system ??= ["prompt.md", "sounds.md", "sound-design.md", "cookbook.md", "reference.md"].map((f) => fs.readFileSync(path.join(DIR, f), "utf8").trim()).join("\n\n");
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
  const history = (r.history ?? []).slice(0, HISTORY);
  if (history.length)
    parts.push(
      `Earlier changes, newest first. Each shows the code as it was before that change:\n\n` +
        history.map((h, i) => `${i + 1}. "${h.request}" (${h.summary || "changed"}). Before it:\n\`\`\`\n${h.code}\n\`\`\``).join("\n\n"),
    );
  if (r.failed) parts.push(`Your last attempt didn't play:\n\`\`\`\n${r.failed.code}\n\`\`\`\nError: ${r.failed.error}`);
  if (r.sounds?.length) parts.push(`Loaded sounds (plain names, then banks with their sounds):\n${soundList(r.sounds)}`);
  return parts.join("\n\n");
}

/** Earlier versions the model sees: enough to step back a few changes. */
const HISTORY = 5;

type ObjectCall = <T>(o: CallOptions & ObjectRequest<T>) => Promise<CompleteResult<T>>;

/** Asks for the change; edits that don't apply are sent back once with the reason. */
export async function changeCode(object: ObjectCall, r: ChangeRequest, signal?: AbortSignal): Promise<ChangeAnswer> {
  if (!r.request.trim()) throw new Error("Say what to change");
  let req = r;
  for (let attempt = 0; ; attempt++) {
    const res = await object<ModelAnswer>({
      tier: "smart",
      purpose: "livecode.change",
      system: changeSystem(),
      cacheSystem: true,
      prompt: changePrompt(req),
      schema: SCHEMA,
      effort: "low",
      maxOutputTokens: 6000,
      signal,
    });
    const { summary, edits, code } = res.value;
    if (code.trim()) return { code: code.replace(/^```\w*\n([\s\S]*?)\n?```\s*$/, "$1"), summary: summary.trim() };
    try {
      return { code: applyEdits(r.code, edits ?? []), summary: summary.trim() };
    } catch (e) {
      if (attempt >= 1) throw e;
      req = { ...r, failed: { code: JSON.stringify(edits, null, 1), error: `${(e as Error).message}. Each find must be copied exactly from the code now playing.` } };
    }
  }
}
