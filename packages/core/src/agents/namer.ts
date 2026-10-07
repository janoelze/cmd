// The model's part in naming agents (docs/32-session-names.md, "The model's
// part"): what it's asked, how its answer is checked, when it's asked at all,
// and when a proposed name is taken. Pure: the live core (step 4) and the eval
// (scripts/evals/names.ts) drive the same functions turn by turn.
//
// A first name as soon as a prompt gives something to name (from the prompt
// alone), else after the turn (with what it wrote and said). Later, cheap
// checks decide whether a turn might be a new task; only then is the model
// asked to classify the newest prompt (continue, develop, change; Def-DTS) and
// to propose a name for a change, which is taken after two changes in a row that
// agree on it (or one with a hard signal), never back to a name it had in the
// last hour.

import path from "node:path";
import { nameKey, outputLanguage } from "@cmd/protocol";

export type Intent = "continue" | "develop" | "change";

/** One turn as the namer sees it. */
export interface NamerTurn {
  at: number;
  prompt: string;
  /** Files the turn wrote. */
  files: string[];
  /** The agent's last message, if any. */
  final?: string | null;
}

export interface NamerInput {
  /** The name now; null asks for a first name. */
  current: string | null;
  /** The turns so far, the newest last. */
  turns: NamerTurn[];
  /** Names of the other live agents in the Space. */
  others: string[];
  /** The project's folder name ("cmd"): the row shows it, the name mustn't repeat it. */
  project?: string | null;
}

export interface NamerAnswer {
  intent: Intent;
  name: string | null;
}

export const NAME_SCHEMA = {
  type: "object",
  properties: { intent: { type: "string", enum: ["continue", "develop", "change"] }, name: { type: ["string", "null"] } },
  required: ["intent", "name"],
  additionalProperties: false,
} as const;

export function nameSystem(language = outputLanguage().name): string {
  return `You name a coding agent's session for a developer who runs several agents at once. The name is how they would point at it ("the tours one") and it is shown as "<name> · done" in notifications.

- 1 to 3 words, at most 24 characters.
- Nouns only: the thing worked on, never the activity. No verbs (fix, add, read, check, update, refactor, investigate, review, survey…). An adjective only where it is part of the thing ("Slow release CI", "Broken update").
- The developer's own words from their prompts and the product's names (Navigator, Spaces, Magic, Tours) over paraphrase. A bug by its symptom.
- Sentence case. Code names as written (calc.py, ⌘W). Never the project's name (<project>), no agent name, no articles, no punctuation, no quotes.
- Specific enough to tell it from other work: a single generic word (Descriptions, Downloads, Settings, Bugs, Cleanup) isn't a name; say what of ("Episode descriptions").
- Different from the other agents' names you are given.
- Written in ${language}.
- Nothing to name (a greeting, a test, "read a few files", a bare slash command, only a pasted image): name null.

Without a current name (<current>none</current>): name the session from everything given, and answer intent "change". Name null only when there is nothing to name.

With a current name, first classify the newest prompt against it:
- continue: the same work, a reply, a small next step, a go-ahead.
- develop: deeper into the same thing (a part of it, a bug in it, its tests or docs).
- change: a different task than the current name says.
Propose a name only for change; otherwise name null.

Examples (what the session is about → name):
the data model, then how agent sessions get names → Session names
marketing videos recorded with scripted tours → Tours
asking for notification permission in the app → Notify permission
the Navigator's recent sessions not filtered by Space → Recent by Space
magic widgets using the agents' status indicator → Widget status lights
the latest update doesn't start → Broken update
icons too small, retina → Icon sizes
the release CI takes 20 minutes → Slow release CI
the "hack the planet" SVG in an empty Space → Hack the planet
remove the gopher link from the navigation → Gopher link
the Widget Library ⌘W e2e test is flaky → Flaky ⌘W test
a notification showed JSON → JSON in notification
"hi", "test", "/release", "just read a few files" → null`;
}

/** Pasted text is often the task itself (an error, a log): its start is kept. */
const PASTE_CHARS = 200;
const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "")
    .replace(/<pasted_content[^>]*>([\s\S]*?)<\/pasted_content>/g, (_, p: string) => {
      const one = p.replace(/\s+/g, " ").trim();
      return `[pasted: ${one.length > PASTE_CHARS ? `${one.slice(0, PASTE_CHARS)}…` : one}]`;
    })
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** The prompt for one question: the current name, the others, the earlier prompts, the newest turn. */
export function nameInput(o: NamerInput): string {
  const newest = o.turns.at(-1);
  const earlier = o.turns.slice(0, -1).slice(-4);
  const files = [...new Set((newest?.files ?? []).map((f) => path.basename(f)))].slice(0, 12);
  return [
    `<current>${o.current ?? "none"}</current>`,
    `<others>${o.others.join(", ") || "none"}</others>`,
    o.project ? `<project>${o.project}</project>` : "",
    earlier.length ? `<earlier>\n${earlier.map((t) => `- ${clip(t.prompt, 300)}`).join("\n")}\n</earlier>` : "",
    `<newest>${clip(newest?.prompt, 800)}</newest>`,
    files.length ? `<files>${files.join(", ")}</files>` : "",
    newest?.final ? `<answer>${clip(newest.final, 300)}</answer>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Words a name may not start with: activities, not things. */
// Only words that are verbs whatever follows: "Release CI", "Build cache", "Show posters" (a TV show) and "Hook design" are things.
const VERBS = new Set("fix fixes fixing add adds adding read reading check checking update updating remove removing implement implementing refactor refactoring make making create creating debug debugging investigate investigating review reviewing explore exploring find finding improve improving look looking let lets rename renaming help convert converting deploy deploying notarize notarizing publish publishing migrate migrating rewrite rewriting redesign restyle tidy speed".split(" "));

/** Why a proposed name can't be used (null: it can), and the name cleaned. */
export function checkName(raw: string | null | undefined, others: string[] = [], project?: string | null): { name: string | null; problem: string | null } {
  if (!raw) return { name: null, problem: null };
  const name = raw.replace(/^["“'`]+|["”'`.!]+$/g, "").replace(/\s+/g, " ").trim();
  if (!name || /^null$/i.test(name)) return { name: null, problem: null };
  const words = name.split(" ");
  if (words.length > 3) return { name, problem: "more than 3 words" };
  if (name.length > 24) return { name, problem: "longer than 24 characters" };
  if (VERBS.has(words[0]!.toLowerCase())) return { name, problem: `starts with a verb (${words[0]})` };
  if (/^v?\d[\d.]*$/i.test(name)) return { name, problem: "only a version or a number" };
  if (project && words.some((w) => nameKey(w) === nameKey(project))) return { name, problem: `has the project's name (${project})` };
  if (others.some((o) => nameKey(o) === nameKey(name))) return { name, problem: "another agent has it" };
  return { name: name[0]!.toUpperCase() + name.slice(1), problem: null };
}

const STOP = new Set("the a an and or but to of in on for with at by from is are was be it this that these those i we you me my our your can could would should will do does did not no yes ok okay please lets let's just also now then so if when what how why where which there here into out up about as all any some more less again still too very really".split(" "));
/** Words of a text worth comparing (3+ letters, not filler), lowercased and roughly stemmed. */
export function contentWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content>/g, " ")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !STOP.has(w))
      .map((w) => w.replace(/(ing|ed|es|s)$/, "")),
  );
}

/** Quiet this long before a prompt makes a shorter prompt with new words worth asking about. */
export const GAP_MS = 30 * 60_000;

/**
 * Whether a finished turn might be a new task (no model): the prompt shares no
 * words with the name or the last prompts (after a long quiet, a shorter one
 * counts too), or it writes in folders the session hasn't. Null: it continues,
 * nothing asked. A quiet alone isn't enough: long sessions pause and go on.
 */
export function mightHaveChanged(name: string, turns: NamerTurn[]): string | null {
  const newest = turns.at(-1);
  const before = turns.slice(0, -1);
  if (!newest || !before.length) return null;
  const quiet = newest.at - (before.at(-1)!.at ?? 0) > GAP_MS;
  const words = contentWords(newest.prompt);
  const known = contentWords([name, ...before.slice(-3).map((t) => t.prompt)].join(" "));
  // A short reply ("yes", "go on", "merge it") is a step, not a task.
  if (words.size >= (quiet ? 2 : 3) && ![...words].some((w) => known.has(w))) return quiet ? "new words after a quiet" : "new words";
  const dirs = new Set(before.flatMap((t) => t.files.map((f) => path.dirname(f))));
  if (dirs.size && newest.files.length && newest.files.every((f) => !dirs.has(path.dirname(f)))) return "new folders";
  return null;
}

/** What the namer remembers between turns. */
export interface NameState {
  name: string | null;
  /** A change proposed by the last turn, waiting for a second. */
  pending: string | null;
  /** Names it had, with when they were left. */
  history: { name: string; until: number }[];
  /** First-name questions asked without an answer. */
  tries: number;
}

export const NO_NAME: NameState = { name: null, pending: null, history: [], tries: 0 };
/** First-name questions (at a prompt and at its turn's end) before the namer waits for a cheap check to fire. */
export const FIRST_TRIES = 6;
/** A name left this recently isn't taken again. */
export const RECENT_MS = 60 * 60_000;

/**
 * The state after a model's answer for a turn at `at`; `hard`: a signal that
 * the task changed beyond doubt (the agent moved to another worktree).
 */
export function decide(s: NameState, answer: NamerAnswer | null, at: number, hard = false): NameState {
  if (!s.name) {
    if (!answer?.name) return { ...s, tries: s.tries + 1 };
    return { ...s, name: answer.name, pending: null, tries: s.tries + 1 };
  }
  if (!answer || answer.intent !== "change" || !answer.name || nameKey(answer.name) === nameKey(s.name)) return { ...s, pending: null };
  const left = (n: string) => s.history.some((h) => nameKey(h.name) === nameKey(n) && at - h.until < RECENT_MS);
  if (left(answer.name)) return { ...s, pending: null };
  // Two changes in a row count only if they agree on what the work is now; else the newer one waits.
  if (!hard && !(s.pending && sameName(s.pending, answer.name))) return { ...s, pending: answer.name };
  return { name: answer.name, pending: null, history: [...s.history, { name: s.name, until: at }].slice(-10), tries: s.tries };
}

/** Two names mean the same thing: the same words, or one shares a word with the other. */
export function sameName(a: string, b: string): boolean {
  if (nameKey(a) === nameKey(b)) return true;
  const wa = contentWords(a);
  return [...contentWords(b)].some((w) => wa.has(w));
}

/** Whether to ask the model about this turn at all, and why. */
export function shouldAsk(s: NameState, turns: NamerTurn[]): string | null {
  if (!s.name) return s.tries < FIRST_TRIES ? "first name" : mightHaveChanged("", turns);
  if (s.pending) return "pending change";
  return mightHaveChanged(s.name, turns);
}

export type Ask = (input: NamerInput & { rejected?: string }) => Promise<NamerAnswer | null>;

/** A turn as it stands when its prompt is submitted: nothing written or said yet. */
export function atPrompt(t: NamerTurn): NamerTurn {
  return { ...t, files: [], final: null };
}

/**
 * One question: the model's answer, its name checked, asked again once with
 * what was wrong, then no name rather than a bad one.
 */
export async function askChecked(ask: Ask, input: NamerInput): Promise<{ answer: NamerAnswer | null; problem: string | null; calls: number }> {
  let answer = await ask(input);
  let checked = checkName(answer?.name, input.others, input.project);
  if (!checked.problem) return { answer: answer && { ...answer, name: checked.name }, problem: null, calls: 1 };
  let problem = `${checked.name}: ${checked.problem}`;
  answer = await ask({ ...input, rejected: problem });
  checked = checkName(answer?.name, input.others, input.project);
  if (checked.problem) problem += `; then ${checked.name}: ${checked.problem}`;
  return { answer: answer && { ...answer, name: checked.problem ? null : checked.name }, problem, calls: 2 };
}
