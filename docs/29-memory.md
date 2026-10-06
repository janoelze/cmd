# Memory and recall

> Status (2026-10-06): **planned, not built**. This was phase 6 of [28](28-data-plan.md), deferred so the data layer could settle first. Everything here builds on what phases 1–5 left: the event log, owned transcripts, the views, the context builder and the eval harness. Read 28 §6 and [27](27-data-research.md) §5 (Graphiti, Mem0, Letta, A-MEM) first.

cmd records what happened. Memory is what follows from it that is still true: decisions, causes found, conventions, where something was left. It's what lets an agent ask "what did we decide about the payments retry?" or "where did we leave the flaky test?" and get an answer with sources, across sessions and agents, without reading a hundred transcripts.

## What it should do (scenarios)

- **M1. An agent asks a question about past work.** `cmd recall "why did we drop deflate for blobs?"` → a short answer with the events it came from (a turn, a commit, a note), in text an agent can use. Same through an MCP tool.
- **M2. An agent starts in a project and gets the essentials.** A few lines that are always true for this repository ("worktree per task; never edit the main checkout", "tests: `pnpm test`; e2e only at the end", "no prettier") without the person repeating them. Today these live in CLAUDE.md and the agents' own memories, per agent; cmd can hold them once for every agent.
- **M3. What changed since I last looked.** "Since Friday in cmd: data layer phases 1–5 merged, search.sqlite gone, redaction tightened." From facts and days, scoped to a project.
- **M4. A fact stops being true.** "Blobs are deflated" became "blobs are zstd". The old fact is kept as expired, with when and why, so "why does it think X" is answerable and history isn't rewritten.
- **M5. The person can see and fix it.** A Memory view per project: facts with their sources, editable blocks, forget a fact.

## Design

### Facts

A view, `memory.facts` in `views.sqlite`, rebuilt from the log like any other (28 §3):

```
fact_id, project_id, text            -- one sentence, standalone ("Blobs are compressed with zstd level 3.")
kind                                 -- decision | cause | convention | state | todo
entities                             -- files, branches, tools, people it's about (for retrieval)
sources                              -- event ids it was drawn from (turns, commits, notes, transcript messages)
valid_at, invalid_at                 -- world time: when it became true, when it stopped (null = still true)
created_at, expired_at               -- when cmd learned it, when cmd replaced it
confidence                           -- 0–1, from the extractor; low ones aren't shown to agents
superseded_by                        -- the fact that replaced it
```

- **Extraction**: after a session or a day settles (the journal's day writer is the natural trigger), a fast-tier call through the context builder gets the day's digest (or a session's turns) plus the project's current facts, and answers with `ADD | UPDATE | EXPIRE | NOOP` per candidate (Mem0's update phase). Contradictions expire, never delete (Graphiti's bi-temporal edges).
- **Sources are mandatory**: a fact without event ids isn't stored. Recall always shows them.
- **Rebuild**: facts are derived, but a model wrote them, so a rebuild is costly. Treat like journal days: keep, mark outdated on a `MEMORY_FORMAT` bump, rewrite recent ones only.

### Blocks

Small, editable, per project, always included in an agent's context (Letta's core memory). Stored as events (`memory.block`, id `block:<project>:<label>`, the newest version wins) so edits have history. Seeded by proposals from facts with kind `convention`; the person accepts or edits them. Budget: about 1,500 characters per project.

### Recall

`recall(question, { projectId?, budget })`:

1. Blocks of the project.
2. Facts: full text over `memory.facts` (FTS on text and entities), filtered by project, still-valid first.
3. Events: the log's FTS for the same words (turns, notes, commits, transcript messages), recent first.
4. Fused (reciprocal rank), cut by the context builder to the budget, sources kept.
5. Optional: a fast-tier answer over the above, citing source ids. Without AI: the ranked facts and events as text.

Vectors (sqlite-vec) only if FTS recall measures badly on the eval set (below); the view can grow an embedding column then.

### Surfaces

- `cmd recall "<question>" [--project PATH] [--json]`: agents call it from their terminals.
- An MCP server in the core (stdio via `cmd mcp`) exposing `recall`, `journal`, `data.query` read-only, so agents that speak MCP don't need the CLI.
- The agent briefing (`agents/peers.ts` already injects text on SessionStart): one line pointing at `cmd recall`, plus the project's blocks.
- A Memory widget: facts by project with sources, blocks to edit, forget.

### Evals

Before shipping: 20–30 questions about this repository's real history with expected answers and source events (from the journal corpus days), scored on: answer contains the expected fact, cites at least one right source, no expired fact presented as current. `scripts/evals/recall.ts`, same shape as the journal eval.

### Privacy

Facts are derived from redacted events and go through the context builder (redacted again). Memory is a class in `DATA_CLASSES` with its own switch; extraction is a background AI feature, off until the person turns it on, and `cmd data explain` says what it sends.

## Open questions

1. Trigger: after each day is written (cheap, a day late), or after each session ends (fresher, more calls)?
2. Scope: per project only, or also per person (preferences across projects)?
3. Blocks vs. CLAUDE.md: import CLAUDE.md conventions as blocks, or point at the file? Two sources of truth would drift.
4. How much of a transcript an extraction sees: the turns' summaries only, or the messages?
5. Should agents be able to write facts (`cmd remember "…"`, like `cmd journal note`)?

## Order of work

1. `memory.facts` view, extraction from journal days, `cmd recall` without AI (FTS + facts). Eval set.
2. Blocks as events, proposals from conventions, the briefing line.
3. AI answers for recall, the MCP server.
4. The Memory widget.
