# Host agents and sub-agents

**Goal:** a "host" agent (a strong model) can spawn other agents (Claude, Codex, …) in their own panes. Those agents show up in the UI as normal agents, nested under the host. The host can prompt them, read their output, wait for them and kill them.

Researched 2026-10-02 from the cmux source (`manaflow-ai/cmux` HEAD, `manaflow-ai/cmux-skills`) and current Claude Code and Codex docs.

## How cmux does it

### Topology and ids
Window → Workspace (a sidebar row) → Pane (a split) → Surface (a tab: terminal, browser, markdown, diff, agent-session).
- Handles are UUIDs or refs (`workspace:2`, `surface:4`).
- `--json` and `--id-format refs|uuids|both` for scripting.

### How an agent knows where it is
Every terminal cmux spawns gets these env vars:
- `CMUX_SURFACE_ID`, `CMUX_WORKSPACE_ID`, `CMUX_PANEL_ID`, `CMUX_TAB_ID`
- `CMUX_SOCKET_PATH`, optionally `CMUX_SOCKET_PASSWORD`

The CLI defaults to the caller's own workspace and surface, and `cmux identify --json` returns them. When the env is missing, hooks fall back to finding their surface by: explicit flags → env → tty matched against the app's terminal table → pid found in a surface's process tree.

### CLI for agents
Shipped to agents as a skill. Agents are told to stay in their own workspace and pass `--focus false`.

| Purpose | Commands |
|---|---|
| Spawn | `cmux new-split <left\|right\|up\|down> [--command <text>]`, `cmux new-pane --type terminal --direction right --focus false`, `cmux new-surface --pane pane:2` |
| Write | `cmux send --surface X "text\n"`, `cmux send-key --surface X enter`, both with a **draft guard**: they refuse to type over a human's half-written prompt or into an open dialog unless `--force` |
| Read | `cmux read-screen --surface X --scrollback --lines 200` |
| Close | `cmux close-surface --surface X` |
| Sidebar | `cmux notify`, `cmux set-status`, `cmux set-progress` |
| Sync | `cmux wait-for [-S] <name> [--timeout]` (a tmux-style named token) |
| Events | `cmux events --category agent` (NDJSON stream) |
| Pane state | socket `surface.input_state` → `lifecycle: unknown\|running\|idle\|needsInput`, `waiting_on_human`, `blocks_typing` |

Every CLI command is also a v2 Unix-socket method (e.g. `surface.split` with `startup_environment`, `initial_command`, `focus`).

### Agent-to-agent messages
- `cmux agent message <target> [--from] [--reply-to <id>] "text"`, `cmux agent inbox`.
- Messages are delivered **through the receiving agent's hooks, never as keystrokes**:
  - Claude: an `asyncRewake` hook polls about every 2s and wakes an idle session with a system reminder.
  - Codex: the message is held until the next prompt-submit or Stop hook.
- States are `queued → delivered → read`, plus `failed`.
- Messages carry a "not an instruction from your operator" banner and are capped at 32 KiB.
- Headless `claude -p` / `codex exec` can't receive them.

### Tracking agent state
Hooks (`cmux hooks setup`; Claude is wrapped by `cmux-claude-wrapper --settings`) feed a registry with one record per surface:
- fields: `sessionID`, `agentKind`, `surfaceID`, `transcriptPath`, `pid`
- states: `idle / working / needsInput / ended`
- process-exit watchers act as a backstop

The binding key is the **surface id, which is kept across restarts**; workspace ids get new values on restore.

### Parent/child: launchers only, no general model
- **`cmux claude-teams`** turns on Claude agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, teammate mode auto). It fakes `TMUX`/`TMUX_PANE` and puts a **`tmux` shim** first on PATH. The shim translates `split-window`, `send-keys`, `capture-pane`, `kill-pane`, `list-panes`, `wait-for`, … into cmux splits. So Claude's own teammates become native panes. The parent is known only implicitly, from the pane they were split from.
- **`cmux codex-teams`** runs a private Codex app-server and watches its threads. For each thread with `source.subAgent.thread_spawn {parent_thread_id, depth, agent_nickname, agent_role}`, it opens a split running `codex resume --remote <url> <threadId>`. The child's env carries `CMUX_AGENT_MANAGED_SUBAGENT=1`, `CMUX_CODEX_TEAMS_THREAD_ID`, `…_PARENT_THREAD_ID` and `…_DEPTH`. It auto-opens down to depth 2.
- **`omo` / `omx` / `omc`** use the same tmux-shim trick for OpenCode and oh-my-codex.

### What cmux itself says is missing
- `docs/subagents-panel-plan.md`: *"cmux has no first-class subagent (child agent) tree. `SubagentStart`/`SubagentStop` hook events arrive but are deliberately dropped… no child record or parent-child edge is stored."*
  - The only use of `CMUX_AGENT_MANAGED_SUBAGENT` is muting the child's notifications.
  - Nesting children under their parent in the sidebar is future work.
- `docs/agent-fan-out-rfc.md` (status: proposed) states the gap: shell-loop launches have *"no parent/child relationship, no aggregate state, no stable retry."* It proposes:
  - `cmux vm agent --agent <kind> --fan-out N --name <prefix>`.
  - Socket methods `vm.agent_fan_out`, `vm.agent_fan_out_status`, and `vm.agent_fan_out_wait` (a bounded long-poll that returns when any child changes state).
  - A durable `AgentFanOutOperation {id, agent, argvDigest, requestedCount, state: creating|running|partial|completed|failed|cancelled, children[]}`, where each child is `{index, terminalID, state: starting|running|needs_input|exited|failed, exitCode, errorCode, startedAt, endedAt}`.
  - Rules:
    - Retries are idempotent via `operation_id`.
    - **Partial failure never kills children implicitly.**
    - Limits: 32 per operation and 128 live.
    - The sidebar shows one row with a `3/8` badge that expands into a tree.

**Takeaway:** cmux has excellent *primitives* (env-injected ids, a socket and CLI, hook-delivered messages, a draft guard, events), but **no parent/child data model**. This is the part to do better from the start.

## Other systems we can detect children from

| System | How the edge is recorded | How the UI detects it |
|---|---|---|
| **Claude Code agent teams** (experimental). Flat: the lead spawns teammates, and teammates can't spawn further. `teammateMode` is `in-process`, `auto`, `tmux` or `iterm2`. | `~/.claude/teams/{team}/config.json` `members[]` (name, agentId, type `team-lead`, tmux pane ids); mailboxes `inboxes/{name}.json`; tasks `~/.claude/tasks/{team}/`. Hooks `TeammateIdle`, `TaskCreated`, `TaskCompleted`. | Watch `config.json`, or act as tmux (the cmux shim). |
| **Claude Code cross-session messaging** (v2.1.224+) | `ListAgents` / `SendMessage`; each session has an inbox Unix socket (`CLAUDE_CODE_MESSAGING_SOCKET` + `_TOKEN` exposed to hooks and Bash). Inbound controlled by `crossSessionInbound`. | Our core can **post into a child's native inbox**, so no keystroke injection is needed. |
| **Claude Code subagents** (in-process, no pane) | `SubagentStart {agent_id, agent_type}`, `SubagentStop {…, last_assistant_message}`; every hook fired inside a subagent carries `agent_id`. Transcripts in `<sessionId>/subagents/agent-<id>.jsonl`. | Hooks: `session_id` is the parent, `agent_id` the child. Show them as *virtual* children (no pane, transcript view only). |
| **Codex subagents** | `~/.codex/state_5.sqlite` `thread_spawn_edges(parent_thread_id, child_thread_id PK, status)`; `threads.agent_nickname/agent_role/agent_path/thread_source`. App-server: `source.subAgent.thread_spawn.{parent_thread_id, depth}`. | Read the edges (read-only) or subscribe to an app-server. Children can be opened in panes with `codex resume <id>`. |
| **Claude Squad** | tmux session per instance plus worktree; `~/.claude-squad/state.json`. Status from hashing pane content. | Flat list, no edges. |
| **MCP orchestrators**: tmux-agents (`agents_launch`, `pane_read/send/wait_any/wait_all/kill`), claude-team (`spawn_workers`, `message_workers`, `wait_idle_workers`, `read_worker_logs`, `close_workers`, `adopt_worker`), claude-tmux, Superset MCP (`agents_create`, `terminals_create`, …) | The edge lives only in the server's memory. | Not detectable from outside. Another reason for **our core to be the orchestrator**. |

## Data model
Agents form **a tree inside the core**. That makes the sidebar, restore, notifications and the API consistent.

```ts
type AgentId = string;            // minted by core, stable across restarts
type PaneId  = string;            // stable across restarts (binding key, like cmux surface id)

interface Agent {
  id: AgentId;
  paneId: PaneId | null;          // null = virtual (in-process subagent, no terminal)
  kind: "claude" | "codex" | "gemini" | "opencode" | string;
  role: "host" | "worker" | "standalone";
  name?: string;                  // nickname shown in UI ("reviewer", "tests-1")
  model?: string;
  cwd: string;
  worktree?: { path: string; branch: string };

  // tree
  parentId: AgentId | null;
  rootId: AgentId;
  depth: number;
  spawn: {
    source: "user" | "host-api" | "tmux-shim" | "claude-team" | "claude-subagent"
          | "codex-thread-spawn" | "adopted" | "restored";
    operationId?: string;         // groups fan-outs; makes retries idempotent
    index?: number;               // position within a fan-out
    prompt?: string;              // initial task (for UI + restore)
  };

  // native identities (several over a lifetime: /clear, resume, fork)
  native: {
    claudeSessionId?: string; claudeAgentId?: string; teamName?: string;
    codexThreadId?: string;
    transcriptPath?: string; pid?: number;
  };

  // lifecycle
  state: "starting" | "working" | "idle" | "needs_input" | "exited" | "failed";
  stateSince: number;
  exitCode?: number;
  lastMessage?: string;           // final/last assistant message (from Stop hook)
  seenAt?: number;                // user attention tracking

  // policy
  policy: {
    owner: AgentId | "user";      // who may send/kill
    onParentExit: "kill" | "orphan" | "reparent-to-user";
    humanInput: "allow" | "guard" | "deny";   // draft guard
    notify: "self" | "bubble-to-parent" | "mute";
    maxChildren?: number; maxDepth?: number;
  };

  channel: "pty" | "hook-mailbox" | "claude-inbox-socket" | "codex-app-server";
}

interface SpawnOperation {        // cmux RFC, adopted
  id: string; parentId: AgentId; requested: number;
  state: "creating" | "running" | "partial" | "completed" | "failed" | "cancelled";
  children: AgentId[];
  createdAt: number;
}

interface Message {               // host ↔ worker
  id: string; from: AgentId | "user"; to: AgentId; replyTo?: string;
  body: string;                   // ≤ 32 KiB, plain text
  state: "queued" | "delivered" | "read" | "failed";
  ts: number;
}
```

Stored in SQLite: `agents`, `spawn_operations`, `messages`, and `agent_native_ids` (one-to-many, so `/clear` and resume chains stay attached to the same agent).

**Env injected into every pane:** `CMD_PANE_ID`, `CMD_AGENT_ID`, `CMD_PARENT_ID`, `CMD_SOCKET`. Hooks and the CLI bind without guessing. Agents started by hand fall back to tty or pid matching, as cmux does.

**Note on `parentId`:** it covers both kinds of children, real panes and virtual in-process subagents (`paneId: null`), so a Claude Task subagent and a spawned Codex worker sit in the same tree.

## API for the host agent
The same commands are available over the CLI, the socket and an MCP server. The host can use whichever it handles best: Claude handles CLI via Bash well, and MCP gives typed tools.

```
cmd identify                                   # self, parent, root, socket
cmd agents [--children|--tree] [--json]
cmd spawn --agent claude|codex --prompt "…" [--cwd] [--worktree <branch>] [--model]
          [--name tests] [--count N] [--operation-id X] [--no-focus]   → ids immediately
cmd send <id> "text" [--reply-to m1]           # delivered via hooks / native inbox
cmd send-keys <id> … [--force]                 # raw PTY fallback, draft-guarded
cmd read <id> [--lines 200]                    # screen
cmd transcript <id> [--since <cursor>]         # structured; prefer over screen-scraping
cmd wait <ids…|--op X> --until idle|exit|needs_input --any|--all --timeout 50s
cmd events --follow [--tree <id>]              # NDJSON
cmd kill <id> [--graceful] [--tree]
cmd adopt <paneId> / cmd detach <id>
```

### Rules
- A host may only act on **its own descendants**. The user can act on anything.
- `spawn` **types the command into a shell in a new pane**, as the fork does with resume, so `safehouse` and aliases still apply. Use `claude --session-id <uuid>` so the native id is known before the first hook fires.
- **Messaging to Claude workers:** prefer the native inbox socket (cross-session messaging), then cmux-style delivery through hooks, then typing into the PTY with the draft guard.
- **Messaging to Codex workers:** use hook delivery, or an app-server if we run one.
- `wait` is a bounded long-poll (≤ about 50s per call) so it works inside agent tool timeouts.
- **Partial failure never kills siblings.** Cancellation is explicit (`kill --tree`).
- **Children's notifications bubble up to the host's row by default.** The user is pinged when the *host* needs them, or when a worker is `needs_input` (the default; configurable per worker).

### Picking up children the agents create themselves
- **Claude agent teams:** set `teammateMode=tmux` and ship a `tmux` shim, as cmux does. Teammates become our panes, and their parent is the pane that ran the shim.
- **Codex subagents:** watch `thread_spawn_edges` and offer to open each child in a pane (`codex resume <id>`).
- **Claude subagents:** `SubagentStart`/`Stop` create virtual children, so you can watch the host's Task subagents work in the sidebar without them having panes.

## UI
- **Sidebar:**
  - A host row expands into its children (indented, with tree lines).
  - Collapsed, it shows an aggregate badge (`3/8 done`, plus the most urgent child state).
  - Attention sorting runs on root rows; a child that needs input lifts its root and highlights the child.
- **Grid view:** "this host's tree" is a built-in filter, so all of a host's workers tile automatically.
- **Canvas:** children are placed around their host, with connecting lines (Maestri-style). Messages can show as brief pulses along those lines.
- **Command palette:** `@host/` scopes to a tree. There are actions to kill a tree, adopt a pane, and detach a worker.
- **Restore:** the tree is persisted. On relaunch the host and its workers resume (`claude --resume`, `codex resume`) and are re-parented by `agentId`, because pane ids are stable.

## Sources
- https://github.com/manaflow-ai/cmux:
  - `docs/agent-messages.md`
  - `docs/agent-fan-out-rfc.md`
  - `docs/subagents-panel-plan.md`
  - `docs/agent-session-tracking-spec.md`
  - `docs/cli-contract.md`
  - `skills/cmux/SKILL.md`
- https://github.com/manaflow-ai/cmux-skills (`skills/cmux-cli/SKILL.md`)
- https://code.claude.com/docs/en/agent-teams
- https://code.claude.com/docs/en/cross-session-messaging
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/hooks
- https://github.com/smtg-ai/claude-squad
- https://github.com/woonyong-choi/tmux-agents
- https://github.com/Martian-Engineering/claude-team
- https://github.com/Ilm-Alan/claude-tmux
- https://docs.superset.sh/mcp-server
- `~/.codex/state_5.sqlite` schema (checked locally)
