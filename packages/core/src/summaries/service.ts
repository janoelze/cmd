// Session summaries (docs/20-session-summaries.md): what an agent session did,
// as a Markdown file to edit and pass on (to the team, into a ticket).
//
// `start` returns once the file exists with the facts cmd recorded (files,
// commits, when) and a Markdown window shows it; the model's answer then
// streams into the same file, which the window re-renders as it changes.
// When it's done, a notification says so (the UI shows it only if you looked
// away). One summary per agent at a time; asking again while one is written
// shows that one.
//
// Inputs: the transcript, read in order (search/parser.ts) and pruned to a
// budget (prune.ts), the agent's recorded turns for the session (files
// changed, prompts when there's no transcript) and git's commits since it began.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { logger } from "@cmd/protocol/node";
import type { Agent, AgentId, AgentTurn, SpaceId, WindowId } from "@cmd/protocol";
import type { CompleteResult, ObjectRequest } from "../ai/backends.ts";
import type { CallOptions } from "../ai/service.ts";
import { parseClaude, parseCodex, type ConversationEntry, type SessionDocument } from "../search/parser.ts";
import { prune, redact } from "./prune.ts";
import { buildContext } from "../ai/context.ts";
import { renderSummary, SUMMARY_SCHEMA, type SummaryFacts, type SummaryText } from "./render.ts";

const log = logger("summaries");

/** Characters of conversation sent: about 40k tokens, a few cents on a fast model. */
export const SUMMARY_BUDGET = 160_000;
/** Rewrites of the file while the answer streams in, at most this often. */
const WRITE_EVERY_MS = 200;

export interface SummaryAi {
  object<T>(o: CallOptions & ObjectRequest<T>): Promise<CompleteResult<T>>;
  /** The fast tier's model, by name, for the file ("Claude Haiku 4.5"); null: no provider. */
  modelName(): string | null;
}

export interface SummaryServiceOptions {
  /** The session's conversation from cmd's own copy of the transcript; null or empty: not there yet. */
  transcript?: (a: Agent) => ConversationEntry[] | null;
  ai: SummaryAi;
  agent: (id: AgentId) => Agent | null;
  turns: (id: AgentId) => AgentTurn[];
  /** "Claude Code", "Codex", … */
  agentTitle: (kind: Agent["kind"]) => string;
  /** Where summaries are kept; null: the system's temp folder. */
  dir: string | null;
  /** Shows `file` in a Markdown window in `spaceId` (an open one if there is); its id. */
  show: (file: string, spaceId: SpaceId) => WindowId;
  notify: (windowId: WindowId, title: string, body: string) => void;
  /** Tests: git's commits since a time, newest first (default: `git log`). */
  commits?: (cwd: string, since: number) => Promise<Commit[]>;
  branch?: (cwd: string) => Promise<string | null>;
}

export interface SummaryStart {
  path: string;
  windowId: WindowId | null;
  /** Resolves with the final Markdown (rejects if the model call failed; the file says why). */
  done: Promise<string>;
}

const git = (cwd: string, args: string[]) =>
  new Promise<string | null>((resolve) =>
    execFile("git", ["-C", cwd, "--no-optional-locks", ...args], { timeout: 5000, maxBuffer: 1 << 20 }, (err, out) => resolve(err ? null : out)),
  );

/** Commits since `since`, newest first, with the files each touched (paths relative to the repository). */
async function gitCommits(cwd: string, since: number): Promise<Commit[]> {
  const out = await git(cwd, ["log", `--since=@${Math.floor(since / 1000)}`, "--no-merges", "-n", "50", "--name-status", "--format=%x00%h%x09%s"]);
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim() ?? cwd;
  return (out ?? "")
    .split("\0")
    .filter((c) => c.trim())
    .map((c) => {
      const [head = "", ...rest] = c.split("\n");
      const files = rest
        .map((l) => l.split("\t"))
        .filter((f) => f.length > 1)
        .map((f) => ({ change: f[0]![0]!, path: path.join(root, f.at(-1)!) }));
      return { hash: head.split("\t")[0]!, subject: head.slice(head.indexOf("\t") + 1), files };
    });
}

type Commit = SummaryFacts["commits"][number] & { files?: { path: string; change: string }[] };

const gitBranch = async (cwd: string) => (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim().replace(/^HEAD$/, "") || null;

const sessionOf = (a: Agent) => a.native.claudeSessionId ?? a.native.codexThreadId ?? null;
const tildify = (p: string) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "session";

/** The session's conversation in order: from the transcript, else from the recorded turns. */
function conversation(a: Agent, turns: AgentTurn[], owned?: (a: Agent) => ConversationEntry[] | null): { entries: ConversationEntry[]; doc: SessionDocument | null } {
  // cmd's own copy of the session first (docs/28, A6); the agent's file when it has none yet.
  const mine = owned?.(a);
  if (mine?.length) return { entries: mine.map(subagentResult), doc: null };
  const file = a.native.transcriptPath;
  const parse = a.kind === "claude" ? parseClaude : a.kind === "codex" ? parseCodex : null;
  if (file && parse) {
    try {
      const entries: ConversationEntry[] = [];
      const doc = parse(fs.readFileSync(file, "utf8"), file, entries);
      if (entries.length) return { entries: entries.map(subagentResult), doc };
    } catch (e) {
      log.warn(`could not read the transcript: ${(e as Error).message}`, { file });
    }
  }
  const entries: ConversationEntry[] = [];
  for (const t of turns) {
    if (t.prompt) entries.push({ role: "user", text: t.prompt, at: t.startedAt });
    for (const c of t.commands) entries.push({ role: "tool", text: `shell: ${c}` });
    if (t.error) entries.push({ role: "assistant", text: `(failed) ${t.error}` });
    if (t.final) entries.push({ role: "assistant", text: t.final, at: t.endedAt ?? undefined });
  }
  return { entries, doc: null };
}

/**
 * Claude reports a finished background task (a subagent) as a prompt of its
 * own: it's the subagent's answer, not something the user asked.
 */
function subagentResult(e: ConversationEntry): ConversationEntry {
  if (e.role !== "user" || !e.text.startsWith("<task-notification>")) return e;
  const tag = (t: string) => new RegExp(`<${t}>([\\s\\S]*?)(?:</${t}>|$)`).exec(e.text)?.[1]?.trim();
  return { ...e, role: "assistant", text: `[${tag("summary") ?? "Background task finished"}] ${tag("result") ?? ""}`.trim() };
}

/**
 * Files changed in the session, each once with its last change, relative to
 * the folder where inside it: from the recorded turns, else (sessions from
 * before cmd recorded them) from the commits made during the session.
 */
function changedFiles(turns: AgentTurn[], commits: Commit[], cwd: string): SummaryFacts["files"] {
  const files = new Map<string, string>();
  const changes = turns.some((t) => t.files.length) ? turns.flatMap((t) => t.files) : [...commits].reverse().flatMap((c) => c.files ?? []);
  for (const f of changes) files.delete(f.path), files.set(f.path, f.change);
  return [...files].map(([p, change]) => ({ path: p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : tildify(p), change }));
}

const SYSTEM = `You summarise a coding agent's session for the person who ran it. They will edit what you write and pass it on: to their team, into a ticket or merge request, or to themselves next week. Write what they would write if they had the time.

# Structure

Write the body under these headings, in this order:

## The ask
What was wanted, written as the request itself with no subject ("Find out why the game boots slowly on Windows, then make it faster and add a loading spinner."), or as the question. One to three sentences, at most 60 words. When the ask grew or shifted during the session, include where it went.

## What we did
The work and the reasoning a reader needs, shaped to the session:
- Building or fixing: the approach, decisions a reviewer would ask about (with the reason), how it was tested and the result.
- Investigating or debugging: what was found and the evidence, the cause (or the best hypothesis, said to be one), what was ruled out.
- Research, planning or design: the options weighed, what was recommended or decided, and why.
- Review, operations, releases, setup: what was checked or run, and the outcome.
A session that did several things covers each, weighted by what it produced; the last prompts are often wrap-up (commit, merge, push) and belong at the end, not the centre. Leave out housekeeping: checking git status, pulling, clarifying the request, retries, tooling trouble.

## What changed
The result, as a list a reviewer can check off; "What we did" said how and why, so don't repeat it here. Changes to the product, the codebase, config, docs or the environment, most important first, as bullets. Say what changed, not which files (cmd lists those below). Commits, merges, pushes, MRs and releases go here as the state things were left in. If nothing changed, one line saying so.

## Next steps
Only when something is left: unfinished work, open questions, risks, follow-ups the session named. When nothing is, leave the heading out entirely; never write "None".

Keep it tight: a reader should get the gist in under a minute. "What we did" is at most 120 words for a session under an hour and 250 for a longer one; a small session gets a sentence per section. Never a retelling step by step. Bullets for lists of parallel things, prose for reasoning. Write as "we" throughout (the user and the agent together; never "you" or "the user"), no greeting, no sign-off.

The title says what the session was about or achieved, as a person would name it ("Logout redirects to the homepage per environment", "Why FL Studio ships get-task-allow"), not a description of the summary.

# Always

- Use only what the session shows. Never invent results, numbers, causes or decisions; if something wasn't checked, don't say it works. Unsure is said as unsure.
- Leave out secrets, tokens, passwords and personal data, even where they appear. "[redacted]" and "[… cut …]" mark text left out before you saw it.
- Write in the language of the user's prompts. Plain and concrete: no filler, no praise, no emoji.`;

/** The prompt's parts for the context builder: the facts, the session (fitted later), the outline of prompts read last. */
function promptParts(facts: SummaryFacts, all: ConversationEntry[]): { facts: string; session: (entries: ConversationEntry[], omitted: number) => string; outline: string } {
  const hm = (t?: number) => (t ? new Date(t).toTimeString().slice(0, 5) + " " : "");
  const label = { user: "user", assistant: "agent", tool: "tool" } as const;
  const head = [
    `Agent: ${facts.agent}`,
    `Project: ${facts.project} (${tildify(facts.cwd)})${facts.branch ? `, branch ${facts.branch}` : ""}`,
    facts.files.length ? `Files changed (recorded by cmd): ${facts.files.slice(0, 80).map((f) => f.path).join(", ")}${facts.files.length > 80 ? ", …" : ""}` : "Files changed (recorded by cmd): none recorded",
    facts.commits.length ? `Commits in the repository since the session began (some may be others' work):\n${facts.commits.map((c) => `${c.hash} ${c.subject}`).join("\n")}` : "",
  ].filter(Boolean);
  const outline = all.filter((e) => e.role === "user").map((e, i) => `${i + 1}. ${hm(e.at)}${e.text.replace(/\s+/g, " ").slice(0, 160)}`);
  return {
    facts: head.join("\n"),
    session: (entries, omitted) => ["", ...(omitted ? [`${omitted} older messages were left out to fit.`, ""] : []), "<session>", ...entries.map((e) => `[${e.role === "user" ? hm(e.at) : ""}${label[e.role]}] ${e.text}`), "</session>", ""].join("\n"),
    // After the session, where it's read last: the end of a session isn't all of it.
    outline: ["Summarise the whole session above. The user's prompts, in order; each one that led to work belongs in the summary, weighted by what it produced:", ...outline].join("\n"),
  };
}

export class SummaryService {
  #o: SummaryServiceOptions;
  /** Set at once, so asking twice quickly doesn't start two. */
  #running = new Map<AgentId, Promise<SummaryStart>>();

  constructor(o: SummaryServiceOptions) {
    this.#o = o;
  }

  get dir(): string {
    return this.#o.dir ?? path.join(os.tmpdir(), "cmd-summaries");
  }

  /** Throws (before writing anything) when there's no such agent or no AI provider; `open: false` shows no window. */
  start(agentId: AgentId, o: { open?: boolean } = {}): Promise<SummaryStart> {
    const running = this.#running.get(agentId);
    if (running) return running;
    const start = this.#start(agentId, o);
    this.#running.set(agentId, start);
    const forget = () => this.#running.get(agentId) === start && this.#running.delete(agentId);
    start.then((s) => s.done.then(forget, forget), forget);
    return start;
  }

  async #start(agentId: AgentId, o: { open?: boolean }): Promise<SummaryStart> {
    const a = this.#o.agent(agentId);
    if (!a) throw new Error(`no such agent: ${agentId}`);
    const model = this.#o.ai.modelName();
    if (!model) throw new Error("No AI provider is set up. Add an API key in Settings → AI.");

    const session = sessionOf(a);
    const turns = this.#o.turns(agentId).filter((t) => !session || !t.sessionId || t.sessionId === session);
    const { entries, doc } = conversation(a, turns, this.#o.transcript);
    if (!entries.length) throw new Error("Nothing to summarise yet: this session has no prompts.");

    const cwd = doc?.cwd ?? a.cwd;
    const startedAt = entries.find((e) => e.at)?.at ?? turns[0]?.startedAt ?? doc?.startedAt ?? null;
    const endedAt = doc?.updatedAt ?? turns.at(-1)?.endedAt ?? Date.now();
    const [branch, commits] = await Promise.all([
      doc?.branch ? Promise.resolve(doc.branch) : (this.#o.branch ?? gitBranch)(cwd),
      startedAt ? (this.#o.commits ?? gitCommits)(cwd, startedAt) : Promise.resolve([]),
    ]);
    const facts: SummaryFacts = {
      agent: this.#o.agentTitle(a.kind),
      project: path.basename(cwd) || cwd,
      cwd,
      branch,
      startedAt,
      endedAt,
      prompts: entries.filter((e) => e.role === "user").length,
      files: changedFiles(turns, commits, cwd),
      commits: commits.map((c) => ({ hash: c.hash, subject: c.subject })),
    };

    const day = new Date(startedAt ?? Date.now()).toISOString().slice(0, 10);
    const file = path.join(this.dir, `${slug(facts.project)}-${day}-${(session ?? a.id).slice(0, 8)}.md`);
    fs.mkdirSync(this.dir, { recursive: true });
    const write = (md: string) => {
      try {
        fs.writeFileSync(file, md);
      } catch (e) {
        log.warn(`could not write the summary: ${(e as Error).message}`, { file });
      }
    };

    let pruned = prune(entries.map((e) => ({ ...e, text: redact(e.text) })), SUMMARY_BUDGET);
    // The input through the context builder: facts and the prompt outline kept, the session fitted by the pruner into what's left.
    const parts = promptParts(facts, entries);
    const ctx = buildContext({
      purpose: "agents.summary",
      budget: SUMMARY_BUDGET + 20_000,
      separator: "\n",
      parts: [
        { name: "facts", text: parts.facts, fixed: true },
        { name: "session", fit: (max) => ((pruned = prune(entries.map((e) => ({ ...e, text: redact(e.text) })), max - 40)), parts.session(pruned.entries, pruned.omitted)) },
        { name: "outline", text: parts.outline, weight: 0.1 },
      ],
    });
    write(renderSummary(facts, {}, { pending: `Summarizing ${facts.prompts === 1 ? "1 prompt" : `${facts.prompts} prompts`} with ${model}…` }));
    const windowId = o.open === false ? null : this.#o.show(file, a.spaceId);

    const footer = (m: string) =>
      `Written by ${m} from ${entries.length} messages${pruned.after < pruned.before ? " (shortened to fit)" : ""} · ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let partial: Partial<SummaryText> = {};
    const flush = () => {
      timer = null;
      last = Date.now();
      write(renderSummary(facts, partial, { pending: "Writing…" }));
    };

    const done = this.#o.ai
      .object<SummaryText>({
        tier: "fast",
        purpose: "agents.summary",
        system: SYSTEM,
        prompt: ctx.text,
        context: ctx.record,
        schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
        maxOutputTokens: 3000,
        onPartial: (p) => {
          partial = p;
          if (!timer) timer = setTimeout(flush, Math.max(0, WRITE_EVERY_MS - (Date.now() - last)));
        },
      })
      .then(
        (r) => {
          if (timer) clearTimeout(timer);
          const md = renderSummary(facts, r.value, { footer: footer(model) });
          write(md);
          log.info("summary written", { agent: agentId, file, sent: pruned.after, of: pruned.before, omitted: pruned.omitted, tokens: r.usage });
          if (windowId) this.#o.notify(windowId, "Summary ready", r.value.title || facts.project);
          return md;
        },
        (e: Error) => {
          if (timer) clearTimeout(timer);
          write(renderSummary(facts, partial, { error: `${e.message} Try again from the terminal's title bar menu.` }));
          if (windowId) this.#o.notify(windowId, "Summary failed", e.message);
          throw e;
        },
      );
    done.catch(() => {}); // the file and the notification say it; callers that wait get the error
    return { path: file, windowId, done };
  }
}
