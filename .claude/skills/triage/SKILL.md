---
name: triage
description: Triage cmd's crash reports and feature ideas from the Discord server (#crashes, #feedback) — see what is new, group duplicates, claim one, fix or plan it, and mark it so other sessions know it was reviewed. Use when the user says "triage", "check discord", "any new crashes", "what's in feedback", "crash reports", or asks what users reported.
---

# Triaging Discord

The app posts crash reports to **#crashes** (a webhook, one message per report, with a
`report.json`) and the feedback form posts to **#feedback**. `scripts/discord.mjs` reads both
through a bot and keeps the triage state **on the messages**, so every session, on any machine,
and Jan in Discord, sees what was already reviewed:

| state | reaction | meaning |
|---|---|---|
| `wip` | 👀 | someone is on it — the thread says who and where |
| `waiting` | ⏳ | nobody can move it until something happens — the thread says what |
| `done` | ✅ | fixed and merged (crashes), shipped (ideas) |
| `dup` | 🔁 | same as another report; the thread points to it |
| `wontfix` | 🚫 | decided against — only when Jan decided |
| `open` | — | clears the state |

The note (`--note`) goes into the message's thread, which `inbox` shows under each message. The
reaction is the state; **the thread is the memory**. The session ends and its chat is gone; the
thread is all the next agent has. So whatever you'd tell Jan about an issue's status, write it into
its thread as well, in full, before you hand back:

- what you found, and what you ruled out;
- where the work is: branch, commit, version it ships in;
- what is still unknown, and why;
- what it waits for, and what the next agent should do when that arrives.

Every state change gets a note; a bare reaction says nothing about why.

## Commands

```sh
pnpm discord inbox                                  # everything open, 👀 or ⏳, grouped by signature
pnpm discord inbox --channel crashes --all          # include ✅ 🔁 🚫 (to find what a new report duplicates)
pnpm discord mark wip crashes/<id> crashes/<id> --note "…"   # several refs at once: a whole group
pnpm discord read crashes --since 30d --json        # raw messages, if inbox isn't enough
```

`inbox` saves attachments to `$TMPDIR/cmd-discord/<channel>/` and prints the paths. Token and
setup: the header of `scripts/discord.mjs`.

## The routine

1. **`pnpm discord inbox`.** Groups with 👀 belong to another session: read their thread notes,
   don't take them over unless the note is stale (days old, branch gone: `git worktree list`,
   `git branch`) — and then say so in a note. Groups with ⏳: check whether what they wait for has
   happened (a release went out, a newer report came in); if so, pick them up like a new one.
2. **Claim before working**: `mark wip <every ref in the group> --note "<what you'll do>, branch <topic>"`.
   Two agents looking at the same inbox is the normal case.
3. **Crashes.** Read `report.json`: `context.version`/`build` say which release, `log` the minutes
   before. First check it isn't already fixed: `git log v<version>..master` around the code that
   throws. Then reproduce or reason it out, and fix on a worktree branch (CLAUDE.md, "Work style").
   A fix that isn't merged is still `wip`, with the branch in the note; `done` once it is on master
   (`--note "fixed in <commit>, ships in the next release"`). Already fixed? `done` with the commit.
   Can't find the cause from what the report holds? Make the next report say more (log lines, the
   stack, context), merge that, and mark the group `waiting` with a note: what you know, what the
   change adds, and what to look for in the first report from the release that ships it.
4. **Ideas.** Don't build them unasked: summarise the open ones for Jan, with what exists already
   (docs/, the README, the CHANGELOG) and a rough size. Mark `wip` only for one he asked you to
   build; `done` when it is merged; `wontfix` only on his word, with his reason.
5. **Duplicates.** A new report matching something already handled (`inbox --all`): `dup` with a
   note naming the first report's ref. If it was marked `done` but shows up in a *newer* version,
   it is not a dup — the fix didn't work: mark the new one `wip` and say so.
6. **Hand back** with a short summary: what was open, what you marked, what needs Jan. Anything
   in that summary about one issue belongs in its thread too: check the notes say it.

## Rules

- Notes are read by people in the channel too: plain, short sentences, no internal noise.
- Never `wontfix` or `dup` something you haven't read. Never clear someone else's 👀 silently.
- A crash report holds paths, a machine id and log lines from someone's Mac: quote it in a commit
  or issue only as far as the fix needs.
