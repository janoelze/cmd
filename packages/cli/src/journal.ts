// `cmd journal …`: what happened, as a work log (docs/23-journal.md). Plain
// Markdown by default, so an agent asked "what did we do this week?" can read
// it as is; --json for the data. Inside a cmd terminal it's that Space's
// journal, else everything (--all, --space, --repo choose).

import type { JournalDay, JournalEvent } from "@cmd/protocol";
import type { Connection } from "@cmd/protocol/node";

type Client = Connection["client"];

export const JOURNAL_HELP = `  journal [--days N] [--all|--space ID|--repo PATH] [--write|--no-write] [--json]
                                      what happened, day by day: releases, features, investigations
  journal note TEXT                   write something down (from an agent's terminal: in its session)
  journal threads [--day YYYY-MM-DD]  how cmd grouped a day, before AI: what a model is given
  journal events [--days N] [--kind K] [--json]
                                      the recorded events: turns, commands, commits, pages, notes
  journal sync                        read new turns, sessions and git now`;

const hm = (t: number) => new Date(t).toTimeString().slice(0, 5);
const dayName = (t: number) => new Date(t).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
const OUTCOME: Record<string, string> = { shipped: "shipped", merged: "merged", fixed: "fixed", answered: "answered", open: "open", dropped: "dropped" };

async function scope(client: Client, opt: Record<string, unknown>, paneId: string | undefined): Promise<{ spaceId?: string; scope?: string }> {
  if (opt.all) return { scope: "all" };
  if (typeof opt.repo === "string") return { scope: `repo:${opt.repo.replace(/^~/, process.env.HOME ?? "~")}` };
  if (typeof opt.space === "string") return { spaceId: opt.space };
  if (paneId) {
    const { pane } = await client.call("identify", { paneId }).catch(() => ({ pane: null }));
    if (pane) return { spaceId: pane.spaceId };
  }
  return { scope: "all" };
}

/** A day as Markdown: a heading, the headline, an entry per line with its time and outcome. */
export function dayMarkdown(d: JournalDay, multiRepo: boolean): string {
  const lines = [`## ${dayName(d.date)}`, ""];
  if (d.headline) lines.push(d.headline, "");
  for (const e of d.entries) {
    const tags = [e.kind, e.outcome && OUTCOME[e.outcome], multiRepo && e.repo ? tilde(e.repo).split("/").pop() : null].filter(Boolean).join(", ");
    lines.push(`- **${hm(e.start)}–${hm(e.end)} ${e.title}** (${tags})${e.summary ? `  \n  ${e.summary}` : ""}`);
  }
  if (d.minor) lines.push("", `_${d.minor} small thing${d.minor === 1 ? "" : "s"} left out._`);
  return lines.join("\n");
}

const eventLine = (e: JournalEvent) => `${new Date(e.at).toISOString().slice(5, 16).replace("T", " ")}  ${e.kind.padEnd(14)} ${e.repo ? tilde(e.repo).split("/").pop()!.padEnd(14) : " ".repeat(14)} ${e.text.replace(/\s+/g, " ").slice(0, 100)}`;

export async function journalCommand(client: Client, pos: string[], opt: Record<string, unknown>, paneId: string | undefined): Promise<number> {
  const [sub, ...rest] = pos;
  const json = !!opt.json;
  const days = typeof opt.days === "string" ? Math.max(1, Number(opt.days)) : undefined;
  switch (sub) {
    case "note": {
      const text = rest.join(" ").trim();
      if (!text) throw new Error("usage: cmd journal note TEXT");
      const r = await client.call("journal.note", { text, paneId });
      console.log(json ? JSON.stringify(r) : "Noted.");
      return 0;
    }
    case "sync":
      await client.call("journal.sync", {});
      return 0;
    case "threads": {
      const date = typeof opt.day === "string" ? new Date(`${opt.day}T12:00:00`).getTime() : Date.now();
      const r = await client.call("journal.threads", { ...(await scope(client, opt, paneId)), date });
      console.log(json ? JSON.stringify(r, null, 2) : r.digest);
      return 0;
    }
    case "events": {
      const s = await scope(client, opt, paneId);
      const evs = await client.call("journal.events", { since: Date.now() - (days ?? 1) * 86400_000, spaceId: s.spaceId, repo: s.scope?.startsWith("repo:") ? s.scope.slice(5) : undefined, kinds: typeof opt.kind === "string" ? (opt.kind.split(",") as JournalEvent["kind"][]) : undefined });
      for (const e of evs) console.log(json ? JSON.stringify(e) : eventLine(e));
      return 0;
    }
    case undefined:
    case "days": {
      const write = opt.write ? "force" : opt["no-write"] ? "never" : "stale";
      const list = await client.call("journal.days", { ...(await scope(client, opt, paneId)), count: days ?? 3, write });
      if (json) return console.log(JSON.stringify(list, null, 2)), 0;
      if (!list.length) return console.log("Nothing recorded yet."), 0;
      const multi = new Set(list.flatMap((d) => d.entries.map((e) => e.repo))).size > 1;
      console.log(list.map((d) => dayMarkdown(d, multi)).join("\n\n"));
      return 0;
    }
    default:
      throw new Error(`unknown: cmd journal ${sub}`);
  }
}
