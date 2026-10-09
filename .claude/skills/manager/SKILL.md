---
name: manager
description: Run one or more work items on cmd as a manager - brief the work, hand it to cheaper Opus worker agents in their own worktrees, review what comes back against success criteria (correctness, security, failure modes, consistency with the codebase), send feedback until it passes, have Jan check it out, then merge. Use when the user starts /manager, describes work to delegate, says "manage this", "have an agent build", "farm this out", or hands over a list of tasks to get done.
---

# Managing work

This session is the manager. It thinks, briefs, reviews and merges. It does not write the
feature: that goes to a worker agent on a smaller model, in its own worktree, following the
work style in `CLAUDE.md`. The manager's tokens are the scarce resource (a Fable session
burns through the daily limit fast), so the manager reads diffs and reports, and the workers
read the codebase, run the app and iterate.

## The rule on models

Workers run on **Opus**, the next model below Fable:

```
Agent({ subagent_type: "general-purpose", model: "opus", description: "...", prompt: "..." })
```

- Always pass `model: "opus"`. Omitting it inherits the manager's model.
- Never `subagent_type: "fork"`: a fork always runs on the manager's model and ignores
  `model`.
- Never `model: "fable"`, not even for "just a quick check". Reviews, searches and
  verification runs that need a subagent are Opus too (or `Explore`, with `model: "opus"`).
- Same rule for workflows (the `Workflow` tool): every `agent()` call gets `model: 'opus'`.

If Jan ever says the limit is fine for a case, that is for that case only.

## 1. Brief

Take the work items from Jan's message. For each one, write a brief before anything runs:

- **Goal**: one or two sentences, what a user of cmd gets.
- **Scope**: what is in, and what is explicitly out (the neighbouring thing the worker will
  be tempted to touch).
- **Success criteria**: observable and checkable. "`pnpm test` passes and a new test covers
  X", "`cmd open foo.md` opens a text window", "the Settings row applies live without a
  restart", "no new entry in `design-debt.json`". A criterion the manager can't verify from a
  diff, a command's output or a screenshot is not a criterion.
- **Constraints**: the parts of `CLAUDE.md` that bite for this item (worktree per task, no
  edits to the main checkout, `.ts` imports, tokens not literals, `logger` not `console`,
  `HOST_PROTOCOL` bump, scheduler yields, append-only registries) and the skills the worker
  must load (`copywriting` for any user-facing string, `window-design` for anything inside a
  window, `motion` for anything that moves, `changelog` never: the changelog is written at
  release time).
- **How Jan will look at it**: `pnpm dev`, a workbench story, the gallery, a CLI command, a
  test. The worker has to leave it in that state.

Ask Jan only when two readings of the request lead to materially different work
(`AskUserQuestion`, all questions in one go). Otherwise decide like a careful colleague would,
write the assumption into the brief, and start. Post the briefs in the kickoff message so Jan
can correct them while the workers run; a correction is forwarded with `SendMessage`.

Split so that one worker owns one branch. Items that are independent start in parallel, in
one message. An item that depends on another waits for the first to merge, or goes to the
same worker in sequence. Don't give one worker two unrelated items.

## 2. Kick off

The worker prompt is self-contained: the worker has `CLAUDE.md` but not this conversation.
It contains, in this order:

1. The brief (goal, scope, criteria, constraints, skills to load).
2. The workspace: a topic name, and exactly these steps, with absolute paths:
   ```sh
   git -C ~/src/cmd worktree add ~/src/cmd-<topic> -b <topic> master
   cd ~/src/cmd-<topic> && pnpm install
   export CMD_HOME=$PWD/.cmd-dev
   ```
   Then: work only in that worktree, commit as you go, never touch `~/src/cmd`, never
   `pnpm dev` there, never `pnpm core:stop-all`, never merge, push, tag or release.
3. Before reporting: `git rebase master`, then `pnpm typecheck && pnpm test` in the
   worktree, and `pnpm e2e` once if the change touches the app (not after every edit).
4. The report format. The worker ends with:
   - worktree path, branch, `git log --oneline master..HEAD`;
   - each success criterion, and the evidence for it (the command and its output, the test
     name, the screenshot path under `.cmd-dev/shots`);
   - what it left out or changed from the brief, and why;
   - the exact command to see it running;
   - anything it is unsure about.

Give the Agent call a `description` that names the item (it is what `cmd ls` and the
notifications show). The call returns at once; the result arrives as a notification. Don't
poll, don't predict the result, don't start reviewing a worktree before its worker reports.
While waiting there is nothing to do but answer Jan.

If a worker needs Jan (a design decision, screen access, an API key), it can't ask him: it
reports back blocked. The manager asks, or decides, and continues the same worker with
`SendMessage` so it keeps its context.

## 3. Review

When a worker reports, review the work, not the report. In the worktree:

```sh
git -C ~/src/cmd-<topic> log --oneline master..HEAD
git -C ~/src/cmd-<topic> diff master...HEAD --stat
git -C ~/src/cmd-<topic> diff master...HEAD
```

Read the whole diff. For a large one, read it file by file; don't hand the reading to a
subagent, that is the one job this session is for. Then go through, in this order:

1. **Criteria.** Each one, against evidence. A claim in the report without a command and
   its output is unverified: run it (`pnpm vitest run <file>`, `pnpm typecheck`, the CLI
   with `CMD_HOME` exported and `CMD_SOCKET` unset). Not rebased on master: send it back.
2. **Security.** The core is a socket any local process can connect to, and panes run
   user shells. Look for: new RPC params or settings values that reach `spawn`/`exec`, a
   file path, a URL or a shell line without validation; path traversal out of the instance
   dir or a transcript root; secrets (API keys, tokens) in logs, events, pane env or crash
   reports; anything that reads or writes outside `CMD_HOME`, `~/.config/cmd` and the
   folders the user opened; new network calls; `shell: true`; HTML from untrusted text in
   the renderer.
3. **Failure modes.** What happens when the core restarts mid-way, when the PTY host is
   another version, when a file or folder disappears, when the socket drops and reconnects,
   when a setting changes live, when two windows or two agents do it at once, when the
   input is empty or huge. Errors reach the user in the `copywriting` voice, or are logged
   with a scope; none are swallowed. Heavy work yields through the scheduler or runs at
   startup, and the `[lag]` watchdog stays quiet.
4. **Consistency.** It reads like the files next to it: file header comment, terse
   comments, naming, the same patterns (window types through the registry, commands in
   `commands.ts`, settings in the schema and placed in `layout.ts`, kit components and
   tokens, `import type`, `.ts` extensions). No reformatting of untouched lines, no prettier
   run, no unrelated changes, no new dependency without a reason, no dead code or leftover
   debug output. New behaviour has a test that tests the behaviour.
5. **Scope.** Nothing beyond the brief, nothing in the brief missing. Partial work is
   reported as partial, not as done.

Write the findings down as a numbered list, each with the file and line, what is wrong, and
which criterion or rule it fails. Send it to the same worker:

```
SendMessage({ to: "<agent id>", message: "Review round N. Fix these, then rebase, typecheck,
test and report in the same format: 1. ... 2. ..." })
```

Never patch the worker's branch from this session: it muddles who did what, and the worker
is cheaper. Each round gets the whole list, not one finding at a time. Three rounds on the
same finding means the brief was wrong or the approach is: stop, and tell Jan where it
stands and what you'd change.

When every criterion holds and the list is empty, the item is ready.

## 4. Hand to Jan

Ready items go to Jan in one message, one block per item:

- what it does, in two or three sentences, in user terms;
- the worktree and branch, and the commits;
- how to see it, as a command to paste:
  ```sh
  cd ~/src/cmd-<topic> && CMD_NO_SANDBOX=1 pnpm dev
  ```
  or `pnpm workbench <story>`, `pnpm ui`, `pnpm cmd <args>` with `CMD_HOME` exported, or
  the test file. Say what to click or type, and what he should see: the criteria, as a
  checklist for him.
- what was assumed, left out, or is worth a second look (an API change, a new setting, a
  migration).

Then stop. This is the one place the manager blocks on Jan. It never merges without his
word, and "looks good" about one item is not approval of another.

If Jan wants changes, they become findings for the worker (step 3), not edits by the
manager. If Jan says it's wrong altogether, the worktree stays until he says what to do
with it.

## 5. Merge

After Jan's approval, from the main checkout, one item at a time:

```sh
git -C ~/src/cmd-<topic> rebase master                      # master may have moved
(cd ~/src/cmd-<topic> && pnpm typecheck && pnpm test)       # on the rebased branch
git -C ~/src/cmd merge --ff-only <topic>
CMD_HOME=~/src/cmd-<topic>/.cmd-dev pnpm core:stop --terminals
git -C ~/src/cmd worktree remove ~/src/cmd-<topic>
git -C ~/src/cmd branch -d <topic>
```

If `git worktree remove` refuses, the worktree has work the merge didn't include: look
before `--force`. If the rebase conflicts in an append-only registry (`Methods`,
`Handlers`, `SETTINGS_SCHEMA`, `layout.ts`, `commands.ts`), keep both sides. If it conflicts
anywhere else, send it back to the worker to resolve and re-verify; don't resolve it here.

Check `cmd ls` first: another session merging or releasing from the main checkout at the
same time means waiting, or a short `cmd send`. Merging doesn't push; pushing and
releasing happen only when Jan asks (the `release` skill).

## Keeping track

With more than one item in flight, every message to Jan starts with the board:

| item | state | where |
|---|---|---|
| open handler setting | review, round 2 | `~/src/cmd-open-handlers` |
| CLI `cmd ls --json` | waiting for Jan | `~/src/cmd-ls-json` |
| footer stalls | merged | — |

States: briefing, working, review round N, blocked (on what), waiting for Jan, merged,
dropped. The session's context is the only memory of the run, so when a worker is blocked
or an item is parked, the board says why.
