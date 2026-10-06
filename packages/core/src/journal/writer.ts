// Writing a day (docs/23-journal.md): the digest goes to a model, which answers
// with entries that name the threads they're made of, and a headline. The answer
// is checked against the threads: unknown refs are dropped, and every thread
// that isn't minor ends up in an entry (one the model left out gets a plain
// entry of its own from its label), so nothing that happened goes missing
// because a model skipped it.

import type { JournalDay, JournalEntry, JournalEntryKind, JournalEvent, JournalOutcome, JournalThread } from "@cmd/protocol";
import type { Digest } from "./digest.ts";

export const ENTRY_KINDS: JournalEntryKind[] = ["release", "investigation", "feature", "fix", "design", "refactor", "research", "review", "ops", "chore"];
export const OUTCOMES: JournalOutcome[] = ["shipped", "merged", "fixed", "answered", "open", "dropped"];

export const SYSTEM = `You keep a work journal for a developer's workspace. From a day's activity (agent sessions, git branches, releases, terminals, pages read), you write the entries a person would put in a work log or a standup: what was done, as a reader skimming a week would want it. Not what tools did; what the work was.

# Input

Each line starting with a ref (S = agent session, B = git branch, R = release, T = terminal, W = browsing, N = note) is one thread: things that belong together by identity. Links after a thread say how threads relate ("edited 5 files in ~/src/app-summary (B4)" means session and branch are the same work). "Group S7 + B5:" introduces threads that the links already show to be one piece of work. A session's prompts are the person's own words, in order: they say what was wanted. Branch commits say what was built. "shipped:" lists what a release contained.

# Entries

- One entry per piece of work. A group is one entry (its refs together), unless it clearly holds unrelated work. A thread on its own is usually one entry. A session and the branch it built are one entry; so are a release and the session that cut it. Several small related fixes may be one entry ("Polished the settings window"). A long session that moved between unrelated tasks becomes several entries (its ref in each).
- Every thread above "Minor" belongs to at least one entry, by ref. Minor threads only when they're part of a real entry.
- title: 2 to 4 words, a name for the work like a good ticket title, sentence case, no trailing period: "Released v0.14.4", "Drag and drop for files", "Search index corruption", "Stripe vs Adyen", "Flaky cart test". Never a prompt, a sentence, "Worked on…" or a raw branch name.
- summary: one or two sentences, at most 40 words, past tense, plain: what was done, changed or found, and why it matters. The summary carries the detail the title leaves out. A release lists the main things it shipped. An investigation says what was found, or that the cause is still open.
- kind: release, investigation (debugging, finding a cause), feature (new capability), fix, design (UI, look, copy), refactor, research (reading, comparing, planning, answering a question), review, ops (setup, config, tooling, environments), chore.
- outcome: shipped (in a release), merged, fixed, answered (a question was answered), open (unfinished, or the cause is unknown), dropped (abandoned or reverted); null when none fits.
- Order does not matter; times come from the threads.

# Headline

One sentence for the whole day, at most 25 words, the way a person would sum up their day: the main things, not a list of everything. No "Today".

# Always

Use only what the input shows. Never invent results, causes or numbers. Prompts may be rough, misspelled or terse; read them for intent. Leave out secrets and personal data. Write in English.`;

export const SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string" },
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          refs: { type: "array", items: { type: "string" } },
          kind: { type: "string", enum: ENTRY_KINDS },
          title: { type: "string" },
          summary: { type: "string" },
          outcome: { type: ["string", "null"], enum: [...OUTCOMES, null] },
        },
        required: ["refs", "kind", "title", "summary", "outcome"],
        additionalProperties: false,
      },
    },
  },
  required: ["headline", "entries"],
  additionalProperties: false,
} as const;

export interface WrittenDay {
  headline: string;
  entries: { refs: string[]; kind: string; title: string; summary: string; outcome: string | null }[];
}

/** The model's answer as a JournalDay: refs resolved, threads it left out added, counts from the events. */
export function toDay(w: WrittenDay, d: Digest, threads: JournalThread[], events: JournalEvent[], o: { date: number; scope: string; writtenBy: string | null }): JournalDay {
  const byThread = new Map(threads.map((t) => [t.id, t]));
  const byEvent = new Map(events.map((e) => [e.id, e]));
  const covered = new Set<string>();
  const entries: JournalEntry[] = [];
  const make = (ids: string[], kind: JournalEntryKind, title: string, summary: string, outcome: JournalOutcome | null): JournalEntry | null => {
    const ts = ids.map((id) => byThread.get(id)).filter((t): t is JournalThread => !!t);
    if (!ts.length) return null;
    for (const t of ts) covered.add(t.id);
    const ev = ts.flatMap((t) => t.events.map((id) => byEvent.get(id))).filter((e): e is JournalEvent => !!e);
    const major = ts.filter((t) => !t.minor);
    // Its span is the work's (sessions, branches, releases), not a dev server left running or pages read around it.
    const core = major.filter((t) => t.kind === "session" || t.kind === "branch" || t.kind === "release");
    const span = core.length ? core : major.length ? major : ts;
    return {
      id: (major[0] ?? ts[0]!).id,
      kind,
      title: title.trim().replace(/\.$/, ""),
      summary: summary.trim(),
      outcome,
      start: Math.min(...span.map((t) => t.start)),
      end: Math.max(...span.map((t) => t.end)),
      repo: ts.find((t) => t.repo)?.repo ?? null,
      threads: ts.map((t) => t.id),
      counts: countsOf(ev),
    };
  };
  for (const e of w.entries) {
    const ids = e.refs.map((r) => d.refs.get(r.trim())).filter((x): x is string => !!x);
    const kind = ENTRY_KINDS.includes(e.kind as JournalEntryKind) ? (e.kind as JournalEntryKind) : "chore";
    const outcome = OUTCOMES.includes(e.outcome as JournalOutcome) ? (e.outcome as JournalOutcome) : null;
    const entry = make(ids, kind, e.title, e.summary, outcome);
    if (entry) entries.push(dedupeId(entry, entries));
  }
  // Work the model left out: an entry per group it didn't touch, from what the data says.
  const missed = new Map<string, JournalThread[]>();
  for (const t of threads) if (!t.minor && !covered.has(t.id)) missed.set(t.group, [...(missed.get(t.group) ?? []), t]);
  for (const g of missed.values()) {
    const f = fallback(g, threads, byEvent);
    const entry = make(g.map((t) => t.id), f.kind, f.title, f.summary, f.outcome);
    if (entry) entries.push(dedupeId(entry, entries));
  }
  return {
    date: o.date,
    scope: o.scope,
    headline: w.headline.trim(),
    entries: entries.sort((a, b) => b.start - a.start),
    writtenBy: o.writtenBy,
    writtenAt: Date.now(),
    inputHash: d.hash,
    minor: threads.filter((t) => t.minor && !covered.has(t.id)).length,
  };
}

/** An entry for a group no model wrote: a release by its tag and what it shipped, else a short name from the branch, the session's title or a commit. */
function fallback(g: JournalThread[], all: JournalThread[], byEvent: Map<number, JournalEvent>): { kind: JournalEntryKind; title: string; summary: string; outcome: JournalOutcome | null } {
  const release = g.find((t) => t.kind === "release");
  if (release) {
    const shipped = release.links.filter((l) => l.rule.startsWith("shipped")).map((l) => all.find((t) => t.id === l.to)?.label ?? l.to.slice(l.to.indexOf("#") + 1));
    return { kind: "release", title: `Released ${release.label}`, summary: shipped.length ? `Shipped ${shipped.map(humanize).join(", ")}.` : "", outcome: "shipped" };
  }
  const ev = g.flatMap((t) => t.events.map((id) => byEvent.get(id))).filter((e): e is JournalEvent => !!e);
  const commits = ev.filter((e) => e.data.kind === "git.commit").map((e) => e.text);
  const merged = ev.some((e) => e.data.kind === "git.merge");
  const branch = g.find((t) => t.kind === "branch" && !t.id.includes("@"));
  const session = ev.find((e) => e.data.kind === "agent.session")?.data;
  const sessionTitle = session?.kind === "agent.session" ? session.title : null;
  const prompt = ev.find((e) => e.data.kind === "agent.turn" && e.data.prompt && !e.data.auto)?.text;
  const title = branch ? humanize(branch.label) : sessionTitle ? words(sessionTitle, 5) : commits[0] ? words(commits[0].split(":")[0]!, 4) : prompt ? words(prompt, 4) : words(g[0]!.label, 4);
  const summary = commits.length ? commits.slice(0, 3).join(". ") : sessionTitle && branch ? sessionTitle : prompt && title !== words(prompt, 4) ? prompt : "";
  return { kind: "chore", title, summary, outcome: merged ? "merged" : null };
}

/** "strip-dots-selection" → "Strip dots selection". */
const humanize = (name: string) => {
  const s = name.replace(/^(feat|fix|chore|wip)[/-]/, "").replace(/[-_/]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** The first `n` words, with an ellipsis when there were more. */
function words(s: string, n: number): string {
  const w = s.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").replace(/\s+/g, " ").trim().split(" ");
  const t = w.slice(0, n).join(" ").replace(/[,.;:]$/, "");
  return w.length > n ? `${t}…` : t;
}

/** A session split into two entries gives both the same first thread: the second gets a suffix. */
function dedupeId(e: JournalEntry, entries: JournalEntry[]): JournalEntry {
  let id = e.id;
  for (let i = 2; entries.some((x) => x.id === id); i++) id = `${e.id}~${i}`;
  return { ...e, id };
}

function countsOf(ev: JournalEvent[]): JournalEntry["counts"] {
  const sessions = new Set<string>();
  const c = { agents: 0, prompts: 0, commands: 0, commits: 0, pages: 0, files: 0 };
  const files = new Set<string>();
  for (const e of ev) {
    const d = e.data;
    if (d.kind === "agent.session") sessions.add(d.sessionId);
    if (d.kind === "agent.turn") {
      sessions.add(d.sessionId ?? d.agentId ?? "?");
      if (d.prompt && !d.auto) c.prompts++;
      for (const f of d.files) files.add(f);
    }
    if (d.kind === "command") c.commands++;
    if (d.kind === "git.commit") c.commits++;
    if (d.kind === "browser.visit") c.pages++;
  }
  c.agents = sessions.size;
  c.files = files.size;
  return c;
}
