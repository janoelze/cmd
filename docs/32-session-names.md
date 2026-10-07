# Session names

> Status (2026-10-07): **plan, not built.** cmd gives every agent session a name of its own: 1–3 nouns, in the person's words, that tell the agents in a Space apart in a notification, a sidebar row, Recent and the Journal, and that follow the work when it changes. Read first: this doc; `packages/core/src/agents/notice.ts` (the notification subject); `apps/desktop/src/renderer/src/model.ts` (a terminal's name); `packages/core/src/data/views/sessions.ts`; the copywriting skill's Notifications. Builds on the event log ([28](28-data-plan.md)) and the context builder.

## Why

Today an agent is called, in order: the name given with `cmd agents spawn --name`, else its terminal title (for Claude Code, its own AI title), else the last prompt. Notifications don't even use that: their subject is the project folder (`subjectOf`), so all 45 agent notifications on the author's Mac on 2026-10-07 read **"cmd · done"** or **"cmd · needs you"**, with three agents working in `cmd` at once.

The agents' own titles (Claude Code writes `ai-title` lines from Haiku, `custom-title` from `/rename`; we read both into `transcript.title`) are not names:

- **Summaries, not handles**: "Marketing videos and UI accessibility survey", "Icon sizing audit and retina support". Too long for a title, and they name the activity as much as the thing.
- **Written early, never revised**: a session that moved from an accessibility audit to tours keeps a title about both.
- **Not distinct**: nothing makes two agents in one Space read differently.
- **The model's words**: "Workspace-übergreifende notifications", "Empty Space placeholder graphic" where the person said "hack the planet".

## What a name is for

A name is how the person would point at an agent talking to a colleague: "the tours one", "the release fix". It is read in four places:

| Where | How it's read |
|---|---|
| Notification title | in under a second, without context |
| Sidebar row, title bar | picked out from a handful |
| Navigator Recent, Journal | recognised days later |
| `cmd ls`, `cmd send` | read and typed by agents |

It is not a summary: the detail line, the status, the turn and the session summary describe. A name only has to identify and remind.

## What a good name is

1. **Short**: 1–3 words, at most ~20 characters, so "Name · done, 2 tasks still running" fits a macOS notification title.
2. **Nouns only**: the thing worked on, never the activity ("Icon sizes", not "Fix icon sizes"; "Slow release CI", not "Speed up CI"). The state already says what the agent is doing. Adjectives are fine where they make the thing ("Slow release CI", "Broken update").
3. **The person's words**: a name is recognised instantly only in one's own vocabulary. Prefer words from the person's prompts and the product's nouns (Navigator, Spaces, Magic, Tours) over the model's paraphrase.
4. **Distinct among the live ones**: unique among the agents in the same Space now, not across history. On a clash the newer one becomes more specific ("Notifications" → "Notify permission").
5. **Current, but stable**: it names what the agent does now, changes only when the task changes (rarely, never back and forth), and keeps it when a follow-up goes deeper on the same thing.
6. **None rather than wrong**: "hi", "test", "/release", a pasted image or "just read a few files" give nothing to name; the agent is called by its kind ("Claude") until a turn does.
7. **English**, through one language variable (below), so names, like all of cmd's text, can follow a UI language later.

Never in a name: the project (the row shows the place), the state, the agent kind, articles, punctuation, dates, verbs.

### Real sessions, renamed by hand

The eval set's first cases (sessions on the author's Mac, 2026-10-01 to 07):

| The agent's title | Name | Why |
|---|---|---|
| Data model changes and agent sessions | **Session names** (was *Data model*) | the work moved |
| Marketing videos and UI accessibility survey | **Tours** (was *Accessibility audit*) | two tasks: the current one |
| Workspace-übergreifende notifications | **Notify permission** | the worktree the person named; English |
| Navigator recent agent sessions filtering | **Recent by Space** | the thing |
| Magic widgets status indicator refactoring | **Widget status lights** | the thing |
| Latest prod update doesn't start | **Broken update** | the symptom, as nouns |
| Icon sizing audit and retina support | **Icon sizes** | |
| Release CI pipeline performance | **Slow release CI** | |
| Hack the planet SVG | **Hack the planet** | the person's words |
| Read journalling and agent state data | **Journal data** | |
| Remove gopher link from navigation | **Gopher link** | |
| Widget Library close e2e test flaky | **Flaky ⌘W test** | |
| Torrent search with multiple sources | **Torrent search** | |
| Download production db with crawls | **Crawl database** | |
| Hooks werden aufgerufen ohne CMD | **Hooks without cmd** | English |
| JSON in notification | **JSON in notification** | already right |
| Read files · hi · say hi · test | *none: "Claude"* | nothing to name |
| /release | **Release** | the command |

Cutting Claude's title down would get about half of these; it misses drift, two-task sessions, the person's words and the worktree.

## In notifications

The title stays *subject · state* (copywriting skill); the subject becomes the agent's name instead of the project. The project is left out for now (decided 2026-10-07): the name is enough to tell agents apart, and the app's name above the title already says "cmd". If agents in several projects turn out to be confusable, the project could go in the notification's subtitle (macOS, Electron's `subtitle`).

The same notifications, as they would have read:

| Today | With names |
|---|---|
| cmd · done — *Tours merged into master; videos saved.* | **Tours · done** — *Merged into master; videos saved.* |
| cmd · done — *Notifications permission UI added; asks whether to merge.* | **Notify permission · done** — *Permission UI added; asks whether to merge.* |
| cmd · needs you — *Wants to edit showcase.tour.ts.* | **Tours · needs you** — *Wants to edit “showcase.tour.ts”.* |
| image-line-com-navigation · done — *Wants to delete nav-seo-hardening-and-tests from GitLab.* | **Gopher link · done** — *Wants to delete the branch from GitLab.* |
| cmd · done — *Summarized the data model and agent session handling.* | **Session names · done** — *…* |
| cmd · done | **Claude · done** (no name yet) |

**A prefix ("Agent Tours · done") was considered** and isn't proposed: it spends 6 of ~40 characters on what every agent notification shares, the state words ("needs you", "done") already say it's an agent, and a name made of nouns reads as the task ("Icon sizes · done"), which is what the person wants to know. An unnamed agent is its kind ("Claude · done"), which says it too. To revisit if names turn out to read like something else in practice.

Two fixes on the way: the body shouldn't repeat the name (the AI wording gets the name and is told not to), and a body cut from a Markdown answer must skip headings (today one read "What a name is for A name is how you'd point at…").

## A name over time

| State | When | Changes |
|---|---|---|
| **None** | before a prompt worth naming | shows the kind |
| **Provisional** | from the first prompt | may change once after the first turn shows what the agent touches |
| **Settled** | after the first turns | only on a change of task, with hysteresis |
| **Renamed** | the task changed | the old name kept: "was Accessibility audit" on hover, "Accessibility audit → Tours" in the Journal |
| **Yours** | renamed by the person | frozen; cmd never names it again until the name is cleared |

The name belongs to the **session**: it outlives the agent (Recent, the Journal, a resume picks it up), and a Claude `/clear` is a new session, so a fresh name comes free. Subagents are named by their job ("Explore") and shown under their parent; they need no distinct name.

### Renaming

- **Rename Agent…** on the agent's title bar and sidebar row context menus, and in the palette (a command in `shared/commands.ts`, like Rename Space…). The field opens with the current name selected; empty hands naming back to cmd.
- `cmd agents rename <id> [name]` (no name: back to cmd).
- A Claude `/rename` (`custom-title`) counts as the person's name too. cmd doesn't write back to the agent: typing `/rename` into a working agent would interrupt it, and its transcript isn't ours to edit.
- Every rename is a labelled case: what cmd called it, what the person wanted, at that point of the session. Kept locally for the eval like the journal's real days, never sent to a model without the person's say-so.

### Names as addresses

Names are how agents and the person address agents (decided 2026-10-07): `cmd ls` shows each agent's name, and `cmd send`, `cmd agents wait|kill` and the rest take a name wherever they take an id.

- **Resolved in the caller's Space first** (where names are kept distinct), then across all Spaces if only one agent there has it; an id or id prefix still works and wins over a name.
- **Matched loosely**: case, spaces and dashes ignored, so `cmd send notify-permission "…"` and `cmd send "Notify permission" "…"` reach the same agent; a unique prefix of a word is enough (`cmd send tours`).
- **Ambiguous is an error** that lists the candidates with their ids and Spaces, never a guess: a message to the wrong agent is worse than none.
- **A renamed agent still answers to its old name** for an hour, if no live agent has taken it, so a message written before the rename arrives.
- Only live agents are addressed; a past session's name finds it in `cmd data entities` and Recent, not in `cmd send`.

## Where names come from

In order of trust; the first that applies wins.

1. **The person**: a rename, `--name`, `/rename`.
2. **The worktree**: in a one-worktree-per-task workflow the branch is a name the person already chose. Almost every session starts in the main checkout and moves later (the notify-permission agent's session is recorded on `master`), so this is the folder the agent **works** in, from the hook events (tool calls' cwd, files edited), not where it started. A first edit or `cd` inside a worktree on a branch other than the default names it: `notify-permission` → "Notify permission" (dashes to spaces, sentence case, no `feature/`-style prefixes, ≤ 3 words else the model shortens it). Deterministic, free, stable, and it arrives when the task becomes concrete.
3. **The model**: the fast tier through the context builder (purpose `session.name`, recorded as `ai.call`), for everything else: the default branch, folders without git, exploration.

Without a provider set up: 1 and 2, else the kind. No name from cutting prompts or the agent's title: a wrong name is worse than "Claude".

### The model's part

**First name**, after the first turn ends (its prompt alone is often "read X" or a pasted image; the turn adds the files and tools): input the first prompts, the files touched, the agent's final message's first lines, the names of the other live agents in the Space (to stay distinct); output one name or `none`. Examples in the prompt (the table above) do more for length than instructions do; the output is checked (1–3 words, no verb from a stoplist, ≤ 24 characters, not a clash) and asked again once, else `none`.

**Change of task**, at each later turn end, in two steps so most turns cost nothing:

1. *Cheap checks* (no model): a hard signal (the worktree changed, the session moved project) renames at once; otherwise the model is asked only if the prompt shares no words with the name or the session's last prompts, or it touches files outside the ones the session has touched, or it comes after 30 minutes of quiet.
2. *Classify, don't ask "did it change?"* (Def-DTS, ACL 2025: classifying each utterance's intent beats asking for a shift directly): given the name, the last few prompts and the new one, the model says `continue`, `develop` (deeper on the same thing) or `change`, and proposes a name only for `change`.

**Hysteresis**: a name changes after two `change` verdicts in a row, or one with a hard signal. Never back to a name it had in the last hour.

### Language

A single `outputLanguage()` (protocol, `"en"` for now) that every AI writer passes to its prompt: names, notification wording, the journal, summaries. A setting once the UI is translated; the variable now so nothing hard-codes "in English". Names are stored with their language, so a switch can name again.

## Storage

- A `session.name` event: `{ name: string | null, by: "user" | "agent" | "worktree" | "model", lang: string, verdict?: "change", was?: string }`, with `sessionId`, `agentId`, `paneId`, `spaceId`, `projectId`. `name: null` by `user` hands naming back. In the `agents` class (a year), `text` = the name (search finds sessions by it).
- The sessions view gets `name` and `name_by` (the newest event's); it is rebuilt from the log like the rest, so names survive `cmd data rebuild sessions`. `data.forget` takes them with the session.
- `Agent` gets `title: { name, by } | null` from its session's view row (an agent without a session yet: from its own events). `subjectOf` and the renderer's name rule read it: the name, else the kind. The terminal title stays the terminal's, shown only for agents without hooks.
- `agent.rename { agentId, name: string | null }` in `Methods`; the handler records the event.

## Measuring it

From cmd's own copy of the transcripts, offline:

- **Replay**: each real session's turns, in order, through the namer (cheap checks, classification, hysteresis), as it would have run live. Per session: names given, renames, when.
- **Measures**: renames per session (aim 0–2; long sessions like the 1,900-message journal one are the test), names over 3 words or with a verb, clashes among agents live at the same time in a Space, renames that a worktree change would have given anyway, agreement with the hand-named table and later with real renames.
- `scripts/evals/names.ts corpus|run`, like the journal's; real sessions stay in `$CMD_HOME/evals/names`, out of the repo, and go to a model only with the person's say-so.

## Plan

| # | Step | Delivers |
|---|---|---|
| 1 | **Names without a model** | `session.name` events and the view's columns, `agent.rename` + Rename Agent… + `cmd agents rename`, `/rename` read as the person's, the worktree rule, `subjectOf` and the renderer on the name else the kind, the two body fixes, `outputLanguage()`, names in `cmd ls` and as targets of `cmd send` and `cmd agents` |
| 2 | **Eval harness** | the hand-named table as fixtures, the replay over real sessions, the measures |
| 3 | **The model's first name** | the prompt with examples, checks, distinctness against live agents; tuned on the eval |
| 4 | **Change of task** | cheap checks, the three-way classification, hysteresis, "was" on hover and in the Journal; tuned on renames per session |
| 5 | **Renames as feedback** | person's renames collected as cases; the prompt's examples drawn from them |

Step 1 alone fixes "cmd · done" for everyone working in worktrees.

## Open questions

- Codex and other agents without `/rename`: the same rules; check their hooks give the working folder (step 1).

## Sources

- Title generators: [OpenAI forum on ChatGPT-style titles](https://community.openai.com/t/prompt-to-get-chatgpt-api-to-write-concise-chat-titles-as-it-does-in-chatgpt-chat-application/85644), [PromptQL chat titles](https://hasura.io/docs/promptql-playground/chats/chat-titles), [OpenHands conversation titles](https://docs.openhands.dev/sdk/guides/agent-server/api-reference/conversations/generate-conversation-title.md): first exchange, 3–7 words, examples over instructions, a default for vague prompts; none rename later.
- Claude Code's titles: [/rename, `ai-title` and `custom-title`](https://blog.vincentqiao.com/en/posts/claude-code-rename/).
- Topic shifts: [Def-DTS](https://arxiv.org/html/2505.21033v1) (intent classes: comment, answer, develop, introduce, change), [DASH](https://arxiv.org/pdf/2512.15042), [CobSeg](https://arxiv.org/pdf/2605.30668).
- Two layers of naming: [Conductor](https://www.conductor.build/docs/concepts/workspaces-and-branches) (a fixed city name per workspace, the branch or PR title beside it).
