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
pnpm discord mark wip --group "no such pane" --note "…"     # every open message of the group whose title has that text
pnpm discord mark wip crashes/<id> crashes/<id> --note "…"   # or name refs (with --group, they are added to it)
pnpm discord read crashes --since 30d --json        # raw messages, if inbox isn't enough
```

A group is marked as one: the note goes to its first (oldest) message's thread, every other message
gets a line pointing there, so 40 reports don't mean 40 copies of the note. Write the note for the
whole group. `--group` takes text from the group's `##` title in `inbox`, and refuses if it matches
more than one group (open ones only; add `--all` to match marked ones too, which is slow: it reads
every thread of 90 days). Use refs for a single message or to split a group.

`inbox` saves attachments to `$TMPDIR/cmd-discord/<channel>/` and prints the paths. Token and
setup: the header of `scripts/discord.mjs`.

## The routine

1. **`pnpm discord inbox`.** Groups with 👀 belong to another session: read their thread notes,
   don't take them over unless the note is stale (days old, branch gone: `git worktree list`,
   `git branch`) — and then say so in a note. Groups with ⏳: check whether what they wait for has
   happened (a release went out, a newer report came in); if so, pick them up like a new one.
2. **Claim before working**: `mark wip --group "<title text>" --note "<what you'll do>, branch <topic>"`.
   Do it as soon as you start looking into a report, without asking Jan first: the claim is what
   keeps other agents off it.
   Two agents looking at the same inbox is the normal case.
3. **Crashes.** Read `report.json`: `context.version`/`build` say which release, `log` the minutes
   before. First check it isn't already fixed: `git log v<version>..master` around the code that
   throws. Then reproduce or reason it out, and fix on a worktree branch (CLAUDE.md, "Work style").
   A fix that isn't merged is still `wip`, with the branch in the note; `done` once it is on master
   (`--note "fixed in <commit>, ships in the next release"`). Already fixed? `done` with the commit.
   Can't find the cause from what the report holds? Make the next report say more (log lines, the
   stack, context), merge that, and mark the group `waiting` with a note: what you know, what the
   change adds, and what to look for in the first report from the release that ships it.
4. **Feedback (#feedback), every time.** A triage covers both channels; "triage crashes" is no
   reason to leave #feedback as it was. Go through every open and 👀 item and bring its state up
   to date before handing back:
   - **Already built or fixed?** Other agents ship features all day, often without touching the
     thread. Search `git log --grep`/`-S`, the README and the CHANGELOG for it. Found: `done`
     with the commits and what the user now does to get it, "ships in the next release" if it
     isn't tagged yet (`git tag --contains <commit>`).
   - **👀 whose branch is merged** (`git merge-base --is-ancestor <branch> master`, or the branch
     is gone and its commits are on master): `done` with the commits. The claiming agent often
     ends without closing it.
   - **Bugs** are handled like crashes (step 3).
   - **Ideas still unbuilt**: don't build them unasked. Summarise them for Jan with what exists
     already (docs/, the README, the CHANGELOG) and a rough size. Mark `wip` only for one he asked
     you to build, `done` when it is merged, `wontfix` only on his word, with his reason.
5. **Duplicates.** A new report matching something already handled (`inbox --all`): `dup` with a
   note naming the first report's ref. If it was marked `done` but shows up in a *newer* version,
   it is not a dup — the fix didn't work: mark the new one `wip` and say so.
6. **Hand back** with a short summary of both channels: what was open, what you marked, what
   needs Jan. Before that, run `pnpm discord inbox` again: nothing in it should be built, merged
   or fixed and still look open. Anything
   in that summary about one issue belongs in its thread too: check the notes say it.

## Rules

- Notes are read by people in the channel too: plain, short sentences, no internal noise.
- Never `wontfix` or `dup` something you haven't read. Never clear someone else's 👀 silently.
- A crash report holds paths, a machine id and log lines from someone's Mac: quote it in a commit
  or issue only as far as the fix needs.
