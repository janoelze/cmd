# How a review doc is written (and worked from)

Every system in this folder has one doc, written against this template so that scores compare and so that an agent can pick an issue, fix it in its own worktree and flip the status without reading anything else.

## Doc skeleton

```markdown
# <NN> <System name>

**Score: X/10** · reviewed 2026-10-10 against commit <sha> · scope: <one line>

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | n/10 | |
| Correctness & robustness | n/10 | |
| Performance | n/10 | |
| Security | n/10 or n/a | |
| Testability & tests | n/10 | |
| Extensibility | n/10 | |
| Code health | n/10 | |

## What this system is
Three to ten sentences: the pieces, the files (with line counts), the design docs it follows (docs/NN-*.md), the flows that matter. Written for an agent that has never opened these files.

## What is good
Bullets. Concrete: what to keep, and what other systems should copy.

## Issues
One subsection per issue, ordered by severity. See "Issue format".

## Course corrections
The two to five changes that would move the score most, in order, each pointing at its issue IDs. This is what the overall score rests on.

## Quick wins
Issues an agent can close in under half a day, by ID.
```

## Issue format

```markdown
### AR1-NN-MM · <short imperative title>

- **Status:** open
- **Severity:** critical | high | medium | low
- **Effort:** S (< ½ day) | M (1–2 days) | L (> 2 days)
- **Where:** `path/file.ts:line`, `path/other.ts:line-line`
- **Depends on:** AR1-NN-MM (optional)

**Problem.** What is wrong, in two to six sentences. Name the symptom a user or developer hits, not only the smell.

**Evidence.** The lines, numbers or measurements that show it: a quoted snippet, a line count, a grep count, a stall measurement, a failing scenario. No evidence, no issue.

**Proposal.** The improvement, or the more powerful or elegant solution: what the code looks like after, which abstraction carries it, what gets deleted. Name prior art when it exists (VS Code, Ghostty, Electron docs; see 00-research.md). If two routes exist, recommend one and say why.

**Success criteria.** A checklist an agent can tick without judgment calls: tests that exist and pass, a measurement under a number, a file under a size, a grep that returns nothing, a behaviour demonstrated in `pnpm e2e`. Three to six boxes.

- [ ] …
- [ ] …
```

IDs: `AR1-<doc number>-<two digit issue number>`, for example `AR1-03-02`. Numbers are never reused; a dropped issue keeps its ID with status `wontfix` and a reason.

## Scores

Scores are 1–10 per dimension, then one overall score that is a judgment, not an average: a system with one critical issue scores low however tidy the rest is.

- 9–10: nothing to do; a model for the rest of the codebase.
- 7–8: sound; issues are local and cheap.
- 5–6: works, but the next few features will cost more than they should; one or two structural changes due.
- 3–4: structural problems that already cause bugs, stalls or rewrites; fix before building on it.
- 1–2: redo.

## Statuses, and how agents work from these docs

`open` → `in progress (<branch>)` → `done (<commit>)`, or `wontfix (<reason>)`.

1. Pick an issue; prefer the Course corrections order of its doc, then severity.
2. Edit its **Status** line to `in progress (<branch>)` and commit that one-line change on `master` of the main checkout before starting (it is the claim; other agents see it in `git log`).
3. Work in a worktree per issue as CLAUDE.md says. Meet every success-criteria box; add a box if you found one that was missing.
4. On merge, set `done (<commit>)`, tick the boxes, and change the doc's score if the issue moved it (say so in the commit message).
5. A fix that invalidates another issue sets that one to `wontfix (superseded by AR1-…)`.

## Rules for reviewers

- Read the files in scope in full, not the first screen. Read the design docs the system follows and judge the code against the stated design; when the design itself is the problem, say so as an issue.
- Measure. Line counts, method counts, call sites, timings from the stall log, test counts per module. A number beats an adjective.
- Deliberate choices documented in `docs/` or in a file's top comment are not issues unless the choice has stopped paying off; then the issue says what changed.
- Distinguish a defect (wrong today) from debt (will cost later) from a missed opportunity (a more powerful or elegant solution exists). All three are issues; the severity differs.
- No issue without a proposal, and no proposal without success criteria.
- Point at files and lines; `path:line` references are clickable for the next agent.
- Do not fix anything. This folder is the only thing a reviewer writes.
