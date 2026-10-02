# Agent integration: detection, state, transcripts, search, resume

Researched 2026-10-02 from this machine (read-only) and the web. Covers Claude Code and Codex CLI. Gemini, opencode, Cursor, Amp and Aider are not installed here, so they are not covered.

## On-disk formats (this machine)

### Claude Code: `~/.claude`, about 1.2 GB, almost all of it in `projects/`

**`projects/<cwd with / and . turned into ->/<sessionId>.jsonl`**: one file per session.
- 104 top-level transcripts in 42 project folders. The largest is 139 MB.
- Subagents get their own files: `<sessionId>/subagents/agent-<id>.jsonl`, plus `.meta.json` (`agentType`, `description`, `spawnDepth`, `toolUseId`).
- Large tool outputs are stored separately in `<sessionId>/tool-results/*`.

**Line types and fields.** Every line has a `type`:
- `assistant` (about 20k)
- `attachment` (about 15.6k; injected context, noise for search)
- `user` (about 10.8k, about 9.7k of which are `tool_result`)
- `ai-title` (`aiTitle`, a good session title)
- `last-prompt`
- `system`, with subtypes `turn_duration`, `away_summary`, `stop_hook_summary`
- `pr-link` (`prUrl`, `prNumber`)
- `cost-state` (`totalCostUSD`, `modelUsage`, lines added and removed)
- `file-history-snapshot`
- `mode`
- `permission-mode`
- `queue-operation`
- `bridge-session`

Message lines (user, assistant, system) carry `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `gitBranch`, `version`, `entrypoint`, `isSidechain` and `message{role, content[]}`.

Content blocks are `text`, `tool_use`, `tool_result`, `thinking` and `image`. The conversation is a **tree linked by `parentUuid`**, not a flat list.

**`history.jsonl`**: `{display, pastedContents, project, sessionId, timestamp}`. Every prompt you typed, which makes it a cheap "my prompts" index.

**`sessions/<pid>.json`** (undocumented): `{pid, sessionId, cwd, startedAt, version, kind, entrypoint, name, status: busy|idle|shell, updatedAt, statusUpdatedAt, messagingSocketPath}`. **This is live state with no setup at all.** Check that `pid` is alive, because a crashed process leaves its file behind.

**Retention**
- Claude Code deletes sessions after `cleanupPeriodDays` (default 30).
- Your own job moves transcripts older than 14 days to `~/claude-transcripts-archive` (1.4 GB, 3,548 flat `<uuid>.jsonl` files).
- Growth is about 85 MB a day on average, with spikes up to about 350 MB.
- **The index must not rely on source files lasting.** It should store what it extracts.

**Hooks already installed**
- `~/.claude/hooks/ghostty-agents-status.sh` is registered for 8 events (see [01](01-prior-work-ghostty-agents.md)).
- Payload keys seen:
  - **Every event:** `session_id`, `transcript_path`, `cwd`, `prompt_id`, `scratchpad_dir`
  - **PreToolUse:** adds `tool_name`, `tool_input`, `tool_use_id`, `permission_mode`, `effort`
  - **PostToolUse:** adds `tool_response`, `duration_ms`
  - **Stop:** adds `last_assistant_message`, `background_tasks`, `session_crons`
  - **Notification:** adds `notification_type` (e.g. `idle_prompt`) and `message`
  - **SessionStart:** adds `source` and `model`

### Codex: `~/.codex`, about 208 MB

**`sessions/YYYY/MM/DD/rollout-<ISO>-<uuidv7>.jsonl`**: 30 files, 30 MB. Each line is `{timestamp, type, payload}`:
- `session_meta` (first line): `id`, `cwd`, `cli_version`, `originator`, `source`, `model_provider`
- `turn_context`: `cwd`, `model`, `effort`, `approval_policy`, `sandbox_policy`, `turn_id`
- `response_item`, with payload types:
  - `message`
  - `reasoning`
  - `function_call` and `function_call_output`
  - `custom_tool_call` and `custom_tool_call_output`
- `event_msg`, with payload types:
  - `user_message` and `agent_message`
  - `task_started` and `task_complete`
  - `turn_aborted`
  - `token_count`
  - `patch_apply_end`
  - `context_compacted`
  - `thread_rolled_back`
  - `web_search_end`
- `world_state`
- `compacted`

Newer builds reportedly write `.jsonl.zst`, so the parser should accept both.

**`state_5.sqlite`, table `threads`**: Codex's own session index.
- Columns: `id`, `rollout_path`, `created_at_ms`, `updated_at_ms`, `cwd`, `title`, `first_user_message`, `preview`, `git_branch`, `git_sha`, `git_origin_url`, `model`, `tokens_used`, `archived`, `agent_nickname`, `agent_role`.
- `thread_spawn_edges` holds subagent links.
- **Open it read-only** (`?mode=ro`), because Codex holds it open in WAL mode.

**Other files**: `history.jsonl` is `{session_id, ts, text}`. `config.toml` currently has no `notify` and no hooks.

## Ways to detect state

| Signal | What it shows | Reliability / notes |
|---|---|---|
| **Claude hooks** (command, or `type:"http"`): SessionStart (`source`: startup/resume/clear/compact/fork), UserPromptSubmit, PreToolUse, PostToolUse(+Failure), PermissionRequest, Notification, SubagentStart/Stop, Stop, StopFailure, Pre/PostCompact, CwdChanged, SessionEnd (`reason`) | started; working + current tool; waiting for permission; idle; turn done; API error; ended; pane ↔ session ↔ transcript | **High.** Needs a pane id in the environment, which sandbox wrappers must pass through (`safehouse --env-pass=…`). `Notification.notification_type` (`permission_prompt`, `idle_prompt`, `agent_needs_input`) is the reliable "needs input" signal. Hook config is only read when a session starts. |
| **`~/.claude/sessions/<pid>.json`** | busy / idle / shell, id, name, cwd | **High, no setup**, but undocumented. Use it as the fallback when hooks are missing. Map it to a pane through the pid's ancestry (pid → PTY). |
| **`claude agents --json`** | live sessions | Documented, but has to be polled |
| **Claude statusline input** | context %, cost, model | Medium: only runs while that session redraws |
| **Codex hooks** (`~/.codex/hooks.json` or `[hooks]` in `config.toml`): SessionStart, SessionEnd, UserPromptSubmit, Pre/PostToolUse, PermissionRequest, Stop (every turn), Interrupt, Pre/PostCompact, Subagent* | same as Claude | **High.** Hooks you add must be approved once. SessionEnd may only fire after 30 minutes idle. **This closes the fork's "Codex = Running" gap.** |
| **Codex `notify`** | turn complete only | Medium; now a thin layer over the hooks |
| **Tailing the transcript** | a `tool_use` without its result means a tool is running; `task_started` without `task_complete` means working; `turn_aborted` | Medium (async writes) |
| **OSC 0/2 window title** | Claude sets a ◐/◑ spinner about every 960 ms while busy and ✳ when idle; the title text is the session name. Codex `tui.terminal_title` includes an action-required state. | Medium. Works with no setup, but can change between versions. |
| **OSC 9 / 777 / 99 notifications**, bell | needs attention / finished | Medium. Plain text, no structure. |
| **Foreground process** (`tcgetpgrp` + `KERN_PROCARGS2`), OSC 133 prompt marks | agent running in this pane vs. at the shell | **High** for "is it running"; says nothing about state |

### Layering
The app combines all of these into one state per pane:

```
process scan  →  is an agent present?  which kind?
   + hooks (Claude/Codex)          → precise state + current tool
   + sessions/<pid>.json (Claude)  → state without hooks
   + OSC title/notifications       → any agent
   + transcript tail               → "what is it doing" detail
```

Better than the fork's temp-file approach: **hooks POST to the app's local socket** (Claude supports `type:"http"` hooks), or call a tiny `cmd hook` CLI that writes to that socket. Then nothing is lost to temp-directory cleanups, and events keep their order instead of last-file-wins.

## Resume

**Claude**
- `claude --resume <id|name|path.jsonl>`
- `-c` / `--continue` for the latest session in the current folder
- `--fork-session` to resume under a new id
- `--session-id <uuid>` to choose the id up front, which is useful so the app knows the id before launch
- `-n <name>`
- `claude attach <id>` for background sessions
- Since v2.1.223, `--resume <id>` searches every project, but still run it from the session's cwd.

**Codex**: `codex resume <id>`, `codex resume --last`, `codex fork [--last]`. The id is the rollout uuid, which is also `threads.id`.

**Run resume commands through the user's shell**, not exec'd directly, so aliases and the sandbox wrapper still apply.

## Search index
**SQLite FTS5**, as in the fork.
- An external-content table, one row per message: `(session, role, kind, ts, text)`.
- Weights: title > prompt > assistant text > tool input.
- An `idents` column holding split identifiers (camelCase, snake_case, path parts).
- A **trigram** FTS table (`tokenize='trigram'`) for substring matches on queries of 3+ characters. It roughly triples the index size. Rank exact matches (unicode61) first, then trigram matches.
- **Skip tool results, thinking and attachments.** They make up most of the bytes, so a few GB of JSONL becomes a few hundred MB of text.
- Add `pr-link` and `cost-state` as facets (filter by PR or by cost).

**Incremental ingest**
1. Watch `~/.claude/projects`, `~/claude-transcripts-archive` and `~/.codex/sessions` (FSEvents).
2. Store `(path, inode, size, mtime, byte_offset)` per file and read only new complete lines.
3. If a file is smaller than its stored offset, re-index the whole file.
4. Skip lines that fail to parse.
5. Deduplicate by session id, so archived copies don't appear twice.
6. Read Codex metadata from `threads` instead of re-parsing rollouts.

**Tantivy** is the step up (BM25, real typo matching, n-grams) if FTS5 ever becomes the bottleneck. At about 3 GB it won't.

## Sources
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/statusline
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/terminal-config
- https://github.com/anthropics/claude-code/issues/88360
- https://learn.chatgpt.com/docs/config-file/config-reference
- https://learn.chatgpt.com/docs/hooks
- https://developers.openai.com/codex/cli/reference
- https://backgrind.com/blog/codex-cli-notifications/
- https://github.com/openai/codex/issues/4005
- https://github.com/openai/codex/pull/12334
- https://github.com/openai/codex/pull/18372
- https://codex.danielvaughan.com/2026/06/08/codex-cli-session-lifecycle-archive-resume-fork-rollout-persistence-management/
- https://github.com/openai/codex/issues/20103
- https://sqlite.org/fts5.html
- https://github.com/quickwit-oss/tantivy
