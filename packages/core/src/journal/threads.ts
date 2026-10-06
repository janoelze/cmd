// Threads: a day's journal events grouped by identity, before any model sees
// them (docs/23-journal.md, "Threads"). An agent session, a git branch, a
// release, a terminal's burst of commands, a browser window's burst of pages.
// Then links between threads, each with the rule that made it: a session that
// edited files in a branch's worktree worked on that branch; a release shipped
// the branches merged since the one before; a session that ran the release
// command made the release. Deterministic: the same events give the same
// threads with the same ids, which is what keeps entries stable when a day is
// written again.

import path from "node:path";
import type { JournalEvent, JournalLink, JournalThread, JournalThreadKind } from "@cmd/protocol";

/** Quiet longer than this starts a new burst (terminal, browser, commits on the default branch). */
const BURST_GAP = 45 * 60_000;
/** A release's own commits ("Changelog for v1.2", "Release v1.2") come this soon before its tag. */
const RELEASE_PREP = 30 * 60_000;
const DEFAULT_BRANCHES = new Set(["master", "main", "trunk", "develop"]);

/** Prompts that say nothing about the work: a session made only of these is minor. */
const TRIVIAL_PROMPT = /^(hi|hello|hey|yes|no|ok|okay|y|n|continue|go|go on|done|stuck\??|thanks?|\/clear|\/compact|say hi|test)[.!?]*$/i;
/** Commands that never make a burst worth telling. */
const TRIVIAL_COMMAND = /^\s*(ls|ll|la|cd|pwd|clear|exit|git (status|st|diff|log|branch|fetch)|history|cat|less|head|tail|which|echo|code \.|open \.)(\s|$)/;

export interface ThreadOptions {
  /** The day's window: events overlapping it are threaded. Earlier events (passed for context) only inform links. */
  from: number;
  to: number;
}

const kindOf = (id: string): JournalThreadKind => (id.split(":")[0] as JournalThreadKind) ?? "other";
const isPrompt = (e: JournalEvent) => e.data.kind === "agent.turn" && !!e.data.prompt && !e.data.auto && !e.data.prompt.startsWith("<task-notification>");

export function buildThreads(all: JournalEvent[], o: ThreadOptions): JournalThread[] {
  const inDay = (e: JournalEvent) => (e.until ?? e.at) >= o.from && e.at < o.to;
  const groups = new Map<string, JournalEvent[]>();
  const add = (id: string, e: JournalEvent) => {
    let g = groups.get(id);
    if (!g) groups.set(id, (g = []));
    g.push(e);
  };

  // Tags, oldest first per repository: a release ships what merged since the one before.
  const tags = all.filter((e) => e.data.kind === "git.tag").sort((a, b) => a.at - b.at);
  const tagOf = (e: JournalEvent) => tags.find((t) => t.repo === e.repo && t.at >= e.at && t.at - e.at <= RELEASE_PREP && e.data.kind === "git.commit" && mentionsVersion(e.data.subject, (t.data as { tag: string }).tag));

  // Bursts: per seed, a new id after a quiet gap.
  const bursts = new Map<string, { id: string; last: number }>();
  const burst = (seed: string, e: JournalEvent) => {
    const b = bursts.get(seed);
    if (b && e.at - b.last <= BURST_GAP) return (b.last = Math.max(b.last, e.until ?? e.at)), b.id;
    const id = `${seed}@${e.at}`;
    bursts.set(seed, { id, last: e.until ?? e.at });
    return id;
  };

  for (const e of [...all].sort((a, b) => a.at - b.at)) {
    if (!inDay(e)) continue;
    const d = e.data;
    switch (d.kind) {
      case "agent.session":
      case "agent.turn":
        if (e.thread) add(e.thread.replace(/^agent:/, "session:agent-"), e);
        break;
      case "command":
        add(burst(`terminal:${d.paneId ?? e.cwd}`, e), e);
        break;
      case "browser.visit":
        add(burst(`browsing:${d.windowId ?? "?"}`, e), e);
        break;
      case "file.open":
        // Context for whatever thread was active; on its own it's a browse through files.
        add(burst(`browsing:files`, e), e);
        break;
      case "note":
        add(d.agentSession ? `session:${d.agentSession}` : `note:${e.id}`, e);
        break;
      case "git.tag":
        add(`release:${e.repo}#${d.tag}`, e);
        break;
      case "git.commit": {
        const tag = tagOf(e);
        if (tag) add(`release:${e.repo}#${(tag.data as { tag: string }).tag}`, e);
        else if (d.branch && !DEFAULT_BRANCHES.has(d.branch)) add(`branch:${e.repo}#${d.branch}`, e);
        else add(burst(`branch:${e.repo}#${d.branch ?? "HEAD"}`, e), e);
        break;
      }
      case "git.merge":
      case "git.branch":
      case "git.rebase":
        if (d.branch && !DEFAULT_BRANCHES.has(d.branch)) add(`branch:${e.repo}#${d.branch}`, e);
        break;
      case "git.checkout":
        if (!DEFAULT_BRANCHES.has(d.to) && !/^[0-9a-f]{7,40}$/.test(d.to)) add(`branch:${e.repo}#${d.to}`, e);
        break;
      default:
        break; // resets, Space open/close: context, not work
    }
  }

  // Where each branch's work happened: worktrees git named, else the sibling folder named after it (<repo>-<branch>).
  const worktrees = new Map<string, string>();
  for (const e of all) {
    const d = e.data;
    const wt = "worktree" in d ? d.worktree : null;
    const b = d.kind === "git.commit" || d.kind === "git.branch" || d.kind === "git.merge" ? d.branch : null;
    if (b && wt && wt !== e.repo && !DEFAULT_BRANCHES.has(b)) worktrees.set(`${e.repo}#${b}`, wt);
  }
  const worktreeOf = (repo: string | null, branch: string) =>
    worktrees.get(`${repo}#${branch}`) ?? (repo ? path.join(path.dirname(repo), `${path.basename(repo)}-${branch}`) : null);

  const threads = new Map<string, JournalThread>();
  for (const [id, events] of groups) threads.set(id, makeThread(id, events));
  const branchThreads = [...threads.values()].filter((t) => t.kind === "branch" && !t.id.includes("@"));

  for (const t of threads.values()) {
    const ev = groups.get(t.id)!;
    if (t.kind === "release") {
      // Shipped: branches merged after the previous tag of the repository, up to this one.
      const tag = ev.find((e) => e.data.kind === "git.tag");
      if (!tag) continue;
      const prev = tags.filter((x) => x.repo === tag.repo && x.at < tag.at).at(-1);
      for (const m of all) if (m.data.kind === "git.merge" && m.repo === tag.repo && m.at <= tag.at && (!prev || m.at > prev.at)) link(t, `branch:${m.repo}#${m.data.branch}`, `shipped in ${(tag.data as { tag: string }).tag}`);
    }
    if (t.kind === "session" || t.kind === "terminal") {
      const files = ev.flatMap((e) => (e.data.kind === "agent.turn" ? e.data.files : []));
      const commands = ev.flatMap((e) => (e.data.kind === "agent.turn" ? e.data.commands : e.data.kind === "command" ? [e.data.command] : []));
      const cwds = ev.map((e) => e.cwd).filter((c): c is string => !!c);
      for (const b of branchThreads) {
        const name = b.id.slice(b.id.indexOf("#") + 1);
        const wt = worktreeOf(b.repo, name);
        const inWt = wt ? files.filter((f) => f.startsWith(wt + "/")).length : 0;
        if (inWt) link(t, b.id, `edited ${inWt === 1 ? "a file" : `${inWt} files`} in ${home(wt!)}`);
        else if (wt && cwds.some((c) => c === wt || c.startsWith(wt + "/"))) link(t, b.id, `ran in ${home(wt)}`);
        const end = "(?=$|[\\s\"'`;&|)])";
        const re = new RegExp(`(worktree add\\b.*-b\\s+${esc(name)}${end}|\\bmerge\\b[^|;&]*\\s${esc(name)}${end}|checkout -b ${esc(name)}${end})`);
        const cmd = commands.find((c) => re.test(c));
        if (cmd) link(t, b.id, /merge/.test(cmd) ? `merged ${name}` : `created ${name}`);
        const sessionBranch = ev.find((e) => e.data.kind === "agent.session")?.data;
        if (sessionBranch?.kind === "agent.session" && sessionBranch.branch === name) link(t, b.id, `session on branch ${name}`);
      }
      // A release made during the session: its tag landed while it worked on releasing.
      for (const r of threads.values()) {
        if (r.kind !== "release") continue;
        const tag = groups.get(r.id)!.find((e) => e.data.kind === "git.tag");
        if (!tag) continue;
        const turn = ev.find((e) => e.data.kind === "agent.turn" && tag.at >= e.at - 60_000 && tag.at <= (e.until ?? e.at) + 3 * 60_000 && /\brelease\b|\/release|\bpublish\b|\bship\b/i.test(`${e.data.prompt ?? ""} ${e.data.commands.join(" ")}`));
        if (turn) link(t, r.id, "released during the session");
      }
    }
  }
  for (const t of threads.values()) t.minor = isMinor(t, groups.get(t.id)!);
  const sorted = [...threads.values()].sort((a, b) => a.start - b.start);
  group(sorted, groups);
  return sorted;
}

/**
 * Joins threads that are one piece of work, by their links: a session with the
 * branches it worked on, and with a release it cut when releasing is what it was
 * for. A release never joins what it shipped (that's the release's list, not its
 * work), and a session linked to three branches or more is an orchestrator: its
 * links stay hints, or one long session would swallow the day.
 */
function group(threads: JournalThread[], events: Map<string, JournalEvent[]>): void {
  const parent = new Map(threads.map((t) => [t.id, t.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const order = new Map(threads.map((t, i) => [t.id, i]));
  const union = (a: string, b: string) => {
    if (!parent.has(a) || !parent.has(b)) return;
    const [x, y] = [find(a), find(b)];
    // The earlier thread names the group.
    if (x !== y) order.get(x)! <= order.get(y)! ? parent.set(y, x) : parent.set(x, y);
  };
  for (const t of threads) {
    if (t.kind !== "session" && t.kind !== "terminal") continue;
    const branches = t.links.filter((l) => l.to.startsWith("branch:"));
    if (branches.length < 3) for (const l of branches) union(t.id, l.to);
    const prompts = (events.get(t.id) ?? []).filter((e) => isPrompt(e) && !TRIVIAL_PROMPT.test((e.data as { prompt: string }).prompt.trim()));
    const releasing = prompts.length <= 3 || prompts.every((e) => /\brelease|\/release|changelog|\bship/i.test((e.data as { prompt: string }).prompt));
    for (const l of t.links) if (l.to.startsWith("release:") && releasing) union(t.id, l.to);
  }
  for (const t of threads) t.group = find(t.id);
}

function makeThread(id: string, events: JournalEvent[]): JournalThread {
  const kind = kindOf(id);
  // A session's span is its turns' when it has some here (its own event spans idle hours).
  const timed = kind === "session" && events.some((e) => e.kind === "agent.turn") ? events.filter((e) => e.kind === "agent.turn") : events;
  const start = Math.min(...timed.map((e) => e.at));
  const end = Math.max(...timed.map((e) => e.until ?? e.at));
  const first = events[0]!;
  return { id, kind, repo: first.repo ?? events.find((e) => e.repo)?.repo ?? null, spaceId: events.find((e) => e.spaceId)?.spaceId ?? null, start, end, label: labelOf(id, kind, events), events: events.map((e) => e.id), links: [], minor: false, group: id };
}

function labelOf(id: string, kind: JournalThreadKind, events: JournalEvent[]): string {
  switch (kind) {
    case "session": {
      const s = events.find((e) => e.data.kind === "agent.session");
      const title = s?.data.kind === "agent.session" ? s.data.title : null;
      return title ?? events.find(isPrompt)?.text ?? s?.text ?? "Agent session";
    }
    case "branch":
    case "release":
      return id.slice(id.indexOf("#") + 1).replace(/@\d+$/, "");
    case "terminal":
      return `Terminal in ${home(events[0]?.cwd ?? "?")}`;
    case "browsing":
      return events[0]?.text ?? "Browsing";
    default:
      return events[0]?.text ?? id;
  }
}

function isMinor(t: JournalThread, events: JournalEvent[]): boolean {
  if (t.links.length) return false;
  switch (t.kind) {
    case "session": {
      if (events.some((e) => e.cwd && /^\/(private\/)?(tmp|var\/folders)\//.test(e.cwd))) return true;
      const turns = events.filter((e) => e.data.kind === "agent.turn");
      if (!turns.length) return t.end - t.start < 3 * 60_000;
      const real = turns.filter((e) => isPrompt(e) && !TRIVIAL_PROMPT.test((e.data as { prompt: string }).prompt.trim()));
      const files = turns.reduce((n, e) => n + (e.data.kind === "agent.turn" ? e.data.files.length : 0), 0);
      return real.length === 0 || (real.length === 1 && files === 0 && t.end - t.start < 2 * 60_000);
    }
    case "terminal":
      return events.every((e) => e.data.kind !== "command" || TRIVIAL_COMMAND.test(e.data.command));
    case "browsing":
      return events.length < 2;
    default:
      return false;
  }
}

function link(t: JournalThread, to: string, rule: string): void {
  if (to !== t.id && !t.links.some((l) => l.to === to)) t.links.push({ to, rule } satisfies JournalLink);
}

/** "Release v0.14.4" and "Changelog for v0.14.4" mention v0.14.4 (with or without the v). */
function mentionsVersion(subject: string, tag: string): boolean {
  const v = tag.replace(/^v/, "");
  return new RegExp(`(^|[^\\d.])v?${esc(v)}($|[^\\d.])`).test(subject) && /release|changelog|bump|version/i.test(subject);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
