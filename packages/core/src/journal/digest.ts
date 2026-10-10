// A day's threads as text for a model (docs/23-journal.md, "Writing a day"):
// compact, chronological, every thread with a short ref (S3, B2, R1) the model
// answers with, and the facts that tell what the work was: a session's prompts
// and last answer, a branch's commits and merge, what a release shipped, a
// terminal's notable commands, the pages read. Minor threads are listed in one
// line each at the end. The same threads give the same text, so its hash says
// whether a day needs writing again.

import path from "node:path";
import { createHash } from "node:crypto";
import type { JournalEvent, JournalThread } from "@cmd/protocol";

/**
 * What happened in a day, hashed, whatever the rules that read it: each event
 * in a thread, by key, span and text. A day is written again when this changes;
 * a change of rules alone (THREADS_FORMAT, WRITER_FORMAT) doesn't change it.
 *
 * With the day's window, it hashes what the day contains (AR1-16-01): a span is
 * clipped to the window, so a session that goes on tomorrow, or began
 * yesterday, doesn't change this day; and a session's text (its title, which a
 * rename or a summary changes from outside the day) is left out, since its
 * turns are what the day did. Without a window it is the hash days were
 * written with before, kept so those days compare as they did.
 */
export function eventsHash(threads: JournalThread[], events: JournalEvent[], window?: { from: number; to: number }): string {
  const byId = new Map(events.map((e) => [e.id, e]));
  const ids = [...new Set(threads.flatMap((t) => t.events))].sort((a, b) => a - b);
  const h = createHash("sha256");
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) continue;
    if (!window) h.update(`${e.key}\0${e.until ?? e.at}\0${e.text}\n`);
    else h.update(`${e.key}\0${Math.max(e.at, window.from)}\0${Math.min(e.until ?? e.at, window.to)}\0${e.kind === "agent.session" ? "" : e.text}\n`);
  }
  return h.digest("hex").slice(0, 16);
}

export interface Digest {
  text: string;
  /** Ref → thread id. */
  refs: Map<string, string>;
  hash: string;
}

const PROMPTS_PER_SESSION = 10;
const PROMPT_CHARS = 240;
const COMMITS_PER_BRANCH = 10;

const hm = (t: number) => new Date(t).toTimeString().slice(0, 5);
const home = (p: string | null) => (p ?? "").replace(/^\/Users\/[^/]+/, "~");
const one = (s: string, n: number) => {
  const t = s.replace(/<pasted_content[^>]*>[\s\S]*?(<\/pasted_content>|$)/g, "[pasted text]").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const PREFIX: Record<string, string> = { session: "S", branch: "B", release: "R", terminal: "T", browsing: "W", note: "N", other: "X" };

export function digest(threads: JournalThread[], events: JournalEvent[], o: { title: string }): Digest {
  const byId = new Map(events.map((e) => [e.id, e]));
  const refs = new Map<string, string>();
  const refOf = new Map<string, string>();
  const counters: Record<string, number> = {};
  for (const t of threads) {
    const p = PREFIX[t.kind] ?? "X";
    const ref = `${p}${(counters[p] = (counters[p] ?? 0) + 1)}`;
    refs.set(ref, t.id);
    refOf.set(t.id, ref);
  }
  const linkText = (t: JournalThread) =>
    t.links
      .filter((l) => refOf.has(l.to))
      .map((l) => `${l.rule} (${refOf.get(l.to)})`)
      .join("; ");

  const lines: string[] = [o.title, ""];
  const multiRepo = new Set(threads.map((t) => t.repo)).size > 1;
  // Groups in the order they began, each one's threads together: the threads of a group are one piece of work by their links.
  const groups = new Map<string, JournalThread[]>();
  for (const t of threads.filter((t) => !t.minor)) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
  const ordered: JournalThread[] = [];
  for (const g of groups.values()) {
    if (g.length > 1) ordered.push({ ...g[0]!, id: `#group`, label: g.map((t) => refOf.get(t.id)).join(" + ") });
    ordered.push(...g);
  }
  for (const t of ordered) {
    if (t.id === "#group") {
      lines.push("", `Group ${t.label}:`);
      continue;
    }
    const ev = t.events.map((id) => byId.get(id)!).filter(Boolean);
    const where = multiRepo && t.repo ? ` · ${path.basename(t.repo)}` : "";
    const head = `${refOf.get(t.id)} · ${hm(t.start)}–${hm(t.end)}${where}`;
    const links = linkText(t);
    switch (t.kind) {
      case "session": {
        const s = ev.find((e) => e.data.kind === "agent.session")?.data;
        const turns = ev.filter((e) => e.data.kind === "agent.turn");
        const agent = s?.kind === "agent.session" ? s.agent : turns[0]?.data.kind === "agent.turn" ? turns[0].data.agent : "agent";
        lines.push(`${head} · ${agent} session "${one(t.label, 90)}"${links ? ` · ${links}` : ""}`);
        const prompts = turns.filter((e) => e.data.kind === "agent.turn" && e.data.prompt && !e.data.auto && !e.data.prompt.startsWith("<task-notification>"));
        if (!prompts.length && s?.kind === "agent.session" && s.firstPrompt) lines.push(`  > ${one(s.firstPrompt, PROMPT_CHARS * 2)}`);
        const shown = prompts.length > PROMPTS_PER_SESSION ? [...prompts.slice(0, PROMPTS_PER_SESSION - 3), ...prompts.slice(-3)] : prompts;
        for (const e of shown) {
          if (e.data.kind !== "agent.turn") continue;
          if (e === shown[PROMPTS_PER_SESSION - 3] && prompts.length > PROMPTS_PER_SESSION) lines.push(`  (… ${prompts.length - PROMPTS_PER_SESSION} more prompts)`);
          const failed = e.data.outcome === "failed" ? " [failed]" : e.data.outcome === "interrupted" ? " [interrupted]" : "";
          lines.push(`  ${hm(e.at)} > ${one(e.data.prompt!, PROMPT_CHARS)}${failed}`);
        }
        const last = [...turns].reverse().find((e) => e.data.kind === "agent.turn" && e.data.final);
        if (last?.data.kind === "agent.turn" && last.data.final) lines.push(`  last answer: ${one(last.data.final, 360)}`);
        const files = new Set(turns.flatMap((e) => (e.data.kind === "agent.turn" ? e.data.files : [])));
        if (files.size) lines.push(`  files changed: ${files.size} (${[...files].slice(0, 6).map((f) => path.basename(f)).join(", ")}${files.size > 6 ? ", …" : ""})`);
        break;
      }
      case "branch": {
        const commits = ev.filter((e) => e.data.kind === "git.commit");
        const merge = ev.find((e) => e.data.kind === "git.merge");
        const name = t.label;
        lines.push(`${head} · ${t.id.includes("@") ? "on" : "branch"} ${name}: ${commits.length} commit${commits.length === 1 ? "" : "s"}${merge ? `, merged ${hm(merge.at)}` : t.id.includes("@") ? "" : ", not merged"}${links ? ` · ${links}` : ""}`);
        const shown = commits.length > COMMITS_PER_BRANCH ? [...commits.slice(0, COMMITS_PER_BRANCH - 1), commits.at(-1)!] : commits;
        for (const c of shown) lines.push(`  - ${one(c.text, 140)}`);
        if (commits.length > COMMITS_PER_BRANCH) lines.push(`  (… ${commits.length - COMMITS_PER_BRANCH} more commits)`);
        break;
      }
      case "release": {
        const tag = ev.find((e) => e.data.kind === "git.tag");
        lines.push(`${head} · release ${t.label}${tag ? ` tagged ${hm(tag.at)}` : ""}`);
        const shipped = t.links.filter((l) => l.rule.startsWith("shipped"));
        if (shipped.length) lines.push(`  shipped: ${shipped.map((l) => `${l.to.slice(l.to.indexOf("#") + 1)}${refOf.has(l.to) ? ` (${refOf.get(l.to)})` : " (earlier day)"}`).join(", ")}`);
        break;
      }
      case "terminal": {
        const cmds = ev.filter((e) => e.data.kind === "command");
        const failed = cmds.filter((e) => e.data.kind === "command" && e.data.exitCode && ![130, 137, 143].includes(e.data.exitCode));
        lines.push(`${head} · ${t.label}: ${cmds.length} commands${failed.length ? `, ${failed.length} failed` : ""}${links ? ` · ${links}` : ""}`);
        const seen = new Set<string>();
        for (const e of cmds) {
          if (e.data.kind !== "command") continue;
          const c = one(e.data.command, 120);
          if (seen.has(c) || /^\s*(ls|cd|clear|pwd|git status)\b/.test(c)) continue;
          seen.add(c);
          if (seen.size > 12) break;
          lines.push(`  $ ${c}${e.data.exitCode && ![130, 137, 143].includes(e.data.exitCode) ? ` [exit ${e.data.exitCode}]` : ""}`);
        }
        break;
      }
      case "browsing": {
        lines.push(`${head} · browsed ${ev.length} pages${links ? ` · ${links}` : ""}`);
        const seen = new Set<string>();
        for (const e of ev) {
          const d = e.data;
          const label = d.kind === "browser.visit" ? `${one(d.title ?? d.url, 90)} (${hostOf(d.url)})` : d.kind === "file.open" ? `file ${home(d.path)}` : e.text;
          if (seen.has(label)) continue;
          seen.add(label);
          if (seen.size > 10) break;
          lines.push(`  - ${label}`);
        }
        break;
      }
      default:
        lines.push(`${head} · ${t.kind === "note" ? "note" : t.kind}: ${one(ev.map((e) => e.text).join(" / "), 300)}`);
    }
  }
  const minor = threads.filter((t) => t.minor);
  if (minor.length) {
    lines.push("");
    lines.push("Minor (no entry needed unless part of something above):");
    for (const t of minor) lines.push(`${refOf.get(t.id)} · ${hm(t.start)} · ${t.kind} · ${one(t.label, 70)}${t.repo ? ` · ${home(t.repo)}` : ""}`);
  }
  const text = lines.join("\n");
  return { text, refs, hash: createHash("sha256").update(text).digest("hex").slice(0, 16) };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
}
