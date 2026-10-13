# Agent integration

**Status:** proposal: research done; nothing built beyond what peer briefings already do (docs/18, `agents/peers.ts`).

Date: 2026-10-13. From two Discord ideas (2026-10-12 "agent connectivity: opt in/out of cmd announcing itself to agents with a global toggle", 2026-10-13 "cmd should expose MCP controls … the operator wastes API tokens") and Jan's take on them: the Operator (docs/51) does a job any coding agent could do, if it had cmd's tools and knew it runs inside cmd.

Read first: docs/08-host-agents.md (cmd as the orchestrator), docs/18-agent-activity.md (the hooks and agent homes), docs/51-operator.md (the tools and the access table this reuses).

## The idea in three sentences

> An agent started in a cmd terminal knows it runs in cmd: which pane and workspace it is in, which other agents work beside it, and what it can ask cmd to do.
> It can ask through cmd's tools, an MCP server every supported agent gets, the same methods the Operator calls: open a browser on the dev server, start a second agent, wait for it, arrange the board.
> One switch, **Agent integration**: agents either know about cmd or they don't.

What this replaces: the Operator's own model loop. The person already has an agent open, paid for and trusted; a second one in a widget that drives the first through the board costs tokens twice and feels less direct. What stays: the Operator's tools, its access table and the app round trips behind them (`windows/app-ask.ts`), now called by the agent the person already talks to.

## What a parent app has to deliver

Four things, each of which fails differently:

1. **Tools**: a way for the agent to act on the host (MCP, or a CLI it runs through its shell).
2. **Identity**: the tools must know *which* agent calls them (the pane, so "open a browser next to me" and "my peers" mean something).
3. **Context**: the agent must be told, without being asked, that the tools exist and when to use them.
4. **An off switch** that leaves nothing behind in the agent's configs or prompts.

## What the research found

Surveyed 2026-10-13 against the official docs of Claude Code, Codex, Gemini CLI, OpenCode, Cursor CLI, Copilot CLI, Amp and Goose, the MCP spec and the Agent Client Protocol (references at the end). The generic findings, not one product's:

### Tools: one stdio command, registered per agent

- **MCP is the common tool format; registering a server is not common.** Every agent reads `{command, args, env}` (stdio) or `{url, headers}` (HTTP), and each keeps it in its own place: a JSON file, a TOML table, a YAML file, a settings layer. There is no shared registry and no environment variable every agent reads.
- **Stdio is the lowest common denominator.** The spec says clients SHOULD support it, ACP requires it of every agent, and some agents support nothing else. A local HTTP server must validate `Origin`, authenticate, and carry the caller's identity in the URL or a header, which a static config entry can't do per pane.
- **Four ways a host gets a server in**, from least to most intrusive:
  1. *Per-session protocol*: a host that speaks ACP passes `mcpServers` in `session/new`. Clean, but only for a host that runs the agent headless and draws its own UI; cmd runs the agent's own TUI in a terminal.
  2. *A config layer named by an env var*: some agents merge an extra settings file or inline JSON named by an environment variable, above user and project config. Set in the pane's env, it writes no file and vanishes outside cmd. Only some agents have one.
  3. *A launch flag* (`--mcp-config` and the like) added by a shell wrapper. Misses every agent not started from an interactive shell: scripts, `exec`, agents started by agents, resumes started by cmd itself if they don't go through the wrapper.
  4. *An entry in the user's own config*. Works however the agent starts, but edits a file the agent also writes, and is seen outside cmd too.
- **Project-scoped config is the wrong layer**: it goes into the user's repository, and every agent gates it behind a trust prompt or skips it silently in an untrusted folder. User-level config and env layers avoid both.
- **Register through the agent's own CLI where it has one** (`<agent> mcp add …`, user scope) rather than editing its config file: the agents rewrite those files themselves, and nobody documents locking.
- **Use a unique server name.** Precedence rules take a whole entry from the winning scope; a user's own server of the same name would shadow ours.

### Identity: don't count on the environment reaching the server

- Agents differ in what env a stdio server gets: some inherit everything, one redacts names that look like secrets, one passes a fixed short list (HOME, PATH, SHELL, USER, LANG, TERM, TMPDIR…) plus what the entry names in an allow-list. `CMD_PANE_ID` arriving in the server's env is therefore not a given.
- What works everywhere: name the variables explicitly in the entry where the agent supports an allow-list, and have the server **fall back to its process ancestry**: the server is a child of the agent, which is a child of the pane's shell. cmd already maps process trees to panes (`native/procinfo.c`, `agents/procinfo.ts`).
- The same holds for authorisation: a server process that can't prove which pane it serves gets read-only tools, not the pane's rights.

### Context: a session-start hook, backed by the server's instructions

- **SessionStart hooks that return `additionalContext`** are the strongest channel. Claude Code, Codex and Gemini CLI all support them, in the same JSON shape (`hookSpecificOutput.additionalContext`), and cmd already installs this hook in all three (docs/18) and uses it for peer briefings. They run only when the hook runs, so they can check that they are inside cmd and say nothing elsewhere; they are computed at session start, so they can carry the pane, the workspace and the peers; and they run again on resume and after compaction, so an old pane id doesn't stick.
- Limits: about 10,000 characters in one agent, about 2,500 tokens in another; plain facts, not imperatives ("You can…", not "You MUST…"): one agent's docs warn that imperative injected text can trip its prompt-injection defences. One agent asks the user to trust a new or changed hook by its hash, so the hook command should change rarely (cmd's points at a script it rewrites, which is why `hooks.ts` keeps the config entry stable).
- **The MCP server's `instructions`** are the second channel: the major clients put them into the model's context with the tool names, even when tool definitions are deferred behind tool search. They are static and short (one agent truncates at 2,048 characters, another advises a self-contained first 512), and agents without hooks may still read them. Use them for what the tools are and when to reach for them, not for state.
- **Global instruction files** (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, …) are loaded everywhere, belong to the user, and can only say "if `CMD_PANE_ID` is set…", which agents rarely check unprompted. Don't write to them. Never write `AGENTS.md` or `CLAUDE.md` into the user's project.
- **System-prompt flags** are recorded on the first request and reused on resume in at least one agent, so they go stale; one agent's variant replaces the whole system prompt. Avoid.
- **MCP resources and prompts** need the user to pull them (an `@` mention, a slash command). Not a way to push context.

### Keeping the tool cost down

- Agents with tool search load only tool names and server instructions at the start; others load every definition. So: **a small set of coarse tools** (the Operator's dozen, not one per method), short descriptions, and the detail in each tool's description where it's read on use.
- Tool results count against the agent's context; one agent caps them at 25,000 tokens and spills the rest to a file. Return what the Operator's tools return now: clipped screens, a few lines per window.
- Mark read-only and destructive tools with MCP's tool annotations, so agents that honour them ask before the risky ones; cmd still enforces its own access table, since clients must treat annotations as untrusted.

### What gets in the way

- **Managed policies**: an organisation's managed MCP file can take exclusive control (one agent then refuses a `--mcp-config` flag outright) or allow-list servers. cmd's server simply won't load there; the hook briefing should then not mention tools it can't see.
- **Trust prompts and approval lists**: some agents keep their own list of approved servers or need a flag to skip it. User-scope entries mostly avoid prompts.
- **Moving targets**: docs moved domains, adapter packages were renamed, and Gemini CLI is being partly replaced by Antigravity CLI for unpaid tiers (June 2026). Pin each agent's registration in one adapter per agent, tested against the agent's current version, as `hooks.ts` does for hooks.

## The recipe

What works best, in order:

1. **Ship one stdio command**, `cmd mcp`, from the `bin/` shim cmd already writes (`hooks.ts`). It talks to the core over `CMD_SOCKET` and resolves its pane from `CMD_PANE_ID`, else from its process ancestry. Outside cmd, or with Agent integration off, it answers with no tools and empty instructions, and exits when the agent closes stdin.
2. **Register it once per agent home**, user scope, beside cmd's hook (the homes registry, `agents/homes.ts`): through the agent's own `mcp add` where it has one, otherwise by editing the user config the way `installHooks` does (ours recognisable by name, everything else kept). Forward `CMD_PANE_ID`, `CMD_SOCKET` and `CMD_PANE_TOKEN` explicitly where the agent filters the env. Prefer an env-var config layer set in the pane's environment where the agent has one and nothing else claims it (no file at all).
3. **Brief at SessionStart** through the hook that is already installed: one block of plain facts, under the agent's limit, built by the core when the session starts and again on resume.
4. **Repeat the essentials in the server's `instructions`**, front-loaded into 500 characters, for agents that read those but take no hook.
5. **Keep the tools few and coarse**, annotated, results clipped; enforce an access table in the core, whatever the agent's own approval said.
6. **One switch removes it all**: turning Agent integration off removes the server entries and stops the briefing; the hooks stay, because activity is always captured.
7. **Don't** write instruction files, project config, system-prompt flags or shell wrappers.

## In cmd

### The switch

`agents.integration`, a boolean, in Settings → Agents, replacing the "Working together" section and its "Tell agents about each other (beta)" row (`agents.peers`, removed; a stored `true` carries over). Title "Agent integration", description along the lines of "Agents in cmd's terminals know they run in cmd: they hear which other agents work beside them and get cmd's tools to open windows, start agents and arrange the board." On by default once the tools have had real use; off until then.

- **On**: the server entries are in every agent home that takes them, the hook returns the briefing, the server lists its tools.
- **Off**: the entries are removed (as `removeHooks` does for hooks), the hook returns nothing, a server still running lists no tools.
- **Activity is captured either way**: the hooks stay installed, so status, needs-input, turns and resume work with the switch off. Only what reaches the model changes.
- `setBriefingFlag` (`agents/setup.ts`) follows `agents.integration` instead of `agents.peers`; the hook script's flag file and the `hook.ingest` path stay as they are.

### The briefing

Built by the core (beside `briefing()` in `agents/peers.ts`), at SessionStart and again on a prompt only when the peers changed, as today. Facts only, short:

```
[cmd] You are running in a terminal pane of cmd, a macOS workspace for terminals and coding agents.
Pane: <id>, named "<name>". Workspace: "<workspace>" (<folder>).
cmd's tools are available as the "cmd" MCP server (open windows and browsers, start and message
agents, wait for them, read other panes, arrange the board); `cmd --help` in the shell does the same.
<peer briefing, when there are peers>
```

When the server didn't register in this home (a managed policy, an agent cmd only knows by process), the tools line names only the CLI.

### The tools

The Operator's tools (`operator/tools.ts`, `window-tools.ts`, `page-tools.ts`), moved to `tools/` (names below) and called through the same `ToolContext`, with the caller's pane as "where I am":

- look (the board, the windows, the agents), read (a pane's screen), open (a terminal, a browser on a URL, a file browser, a file), close, focus, arrange;
- agent (start one, send to one, stop one), wait (for agents or a line of output), events;
- run (a Workspace Action by name), page (read or act on a browser page), search (transcripts).

What changes against the Operator:

- **Who asks**: the agent's own approval flow asks first (an MCP call is a tool call like any other). The access table stays the authority: `TOOL_ACCESS`, one table whoever calls, `never` by default, typed against `Method`.
- **Confirm** entries (text typed into another pane, a page act, an edit) still ask in cmd, on the window acted on, since the agent's prompt shows only what the agent chose to send. Remembered approvals (today `operator.grants`, then `approvals.list`) carry over per workspace.
- **Marks on the board** stay: the window acted on lights up and its title bar says which agent acts on it.
- **No `edit` tool**: the agent edits files itself.
- **Reports**: what an agent starts (another agent, an action) reports back to it. The Operator's `<news>` notes become reports, delivered through the briefing path: the hook's `UserPromptSubmit` context, or a `wait` call.

### One source, no drift

Two layers, each defined once; every surface is generated from them.

- **Methods** (`Methods` in `rpc.ts`): the low-level calls. Already held together by tsc (a missing handler, an access table that hasn't decided a new method: `TOOL_ACCESS` (today `OPERATOR_ACCESS`) and `REMOTE_ACCESS` are typed against `Method`) and `registries.test.ts` (every method has a caller). MCP adds no method and no second definition of one.
- **Tools**: about a dozen task-shaped verbs over the methods, the Operator's today (`operator/tools.ts`, `window-tools.ts`, `page-tools.ts`). Each already holds its name, description, JSON Schema input, whether it acts and what it asks. They compose methods (`read` by window kind, clipped and marked untrusted; `agent start` waits until the agent is past starting), which is why methods aren't exposed one MCP tool each: 200+ id-and-flag tools would fill the agent's context and skip the clipping and the approvals.

The tools move from `operator/` to a registry of their own (`packages/core/src/tools/`), and every surface reads it:

| Surface | From the registry |
|---|---|
| MCP (`cmd mcp`) | `tools/list` is the registry (name, description, `inputSchema`, annotations derived from the access table); `tools/call` runs one by name with a `ToolContext` for the calling pane. No tool definitions of its own: an adapter about the size of `hook-main.ts`. |
| CLI | `cmd tools` lists them with the same descriptions, `cmd tool <name> '<json>'` runs one; generated, for agents without MCP. The hand-written commands (`cmd spawn`, `send`, `wait`) stay for people and can become thin over the tools. |
| Operator (if kept) | The same registry it uses now. |

One access table for the tools, whoever calls (`TOOL_ACCESS`); MCP's `readOnlyHint` and `destructiveHint` come from it, so approvals don't drift either. Tests: every method a tool calls is allowed in the table (`ToolContext` checks it at run time; a test catches it before a release); `cmd mcp`'s list and `cmd tools` equal the registry; descriptions under a budget, the server's instructions under 500 characters; `registries.test.ts` adds "every tool is reachable from MCP and the CLI".

### Names

The Operator may be retired, so nothing shared is named after it, nor after one transport (RPC, MCP). The concepts:

| Concept | Name | Today |
|---|---|---|
| A low-level call of the core | **method** (`Methods`, `Method`): the core's API; JSON-RPC is only how it travels | same |
| A task-shaped verb a model calls, with a description and a JSON Schema input | **tool** (`Tool`, `TOOLS`, folder `packages/core/src/tools/`, files by area: `agents.ts`, `windows.ts`, `pages.ts`, …). The word every model API and agent uses for this, not MCP's own | `OperatorTool`, `OPERATOR_TOOLS`, `WINDOW_TOOLS`, `PAGE_TOOLS` in `operator/` |
| Who calls a tool | **caller** (`Caller`: `{ kind: "agent" \| "person", paneId?, workspaceId }`): an agent in a pane, the person, anything later | implicit: the Operator |
| What a tool runs with | **`ToolContext`**: the caller, `call()` checked against the access table, the window refs, the workspace (as `CoreContext` is for services) | `Bench` |
| What a tool may call | **access** (`TOOL_ACCESS`, `Access`: `read`, `act`, `confirm`, `never`), beside `REMOTE_ACCESS`; quiet events with it (`QUIET_EVENTS`) | `OPERATOR_ACCESS`, `OperatorAccess`, `OPERATOR_QUIET_EVENTS` |
| A call waiting for the person | **approval** (`Approval`); kept ones are **remembered approvals** (`approvals.list`, `approvals.answer`, `approvals.forget`) | `Ask`, `operator.answer`, `operator.grants`, `operator.revoke`, `OperatorGrant` |
| Text refused outright | **deny-list** (`tools/deny.ts`) | `operator/deny.ts` |
| What something a caller started says when it ends, fails or needs input | **report** | `<news>` |
| A window being acted on (ring, title-bar line) | **acting** mark, naming the caller | the Operator's ring |
| A tool call in the event log | **`tool.call`** in a `tools` data class, with the caller | `operator.tool` |
| Context an agent gets at session start | **briefing** | peer briefing |
| The switch and the feature | **Agent integration** (`agents.integration`) | `agents.peers` |
| The MCP server | **`cmd`** (tools appear as `mcp__cmd__open`…); `cmd mcp` starts it. Adapters are named by transport (`tools/mcp.ts`), the only place one is | none |

What stays the Operator's and goes with it: its service and conversations (`service.ts`, `store.ts`), prompt and rules (`prompt.ts`, `brief.ts`, `RULES`, `MAX_STEPS`), the widget type, and the `operator.*` methods for its chat (`get`, `send`, `stop`, `reset`, `history`, `open`).

### The Operator

With its tools in every agent, the Operator's loop is a second agent doing what the first could. Two ways on, Jan's call: keep it as a small preset (a widget that starts the user's own agent with the briefing and the tools, no model loop of its own), or retire it and keep only its pieces (tools, access table, app round trips, chat kit components for anything else that needs them).

## Phases

1. **The switch**: `agents.integration` replaces `agents.peers` (settings schema, `layout.ts`, `SettingsWindow.tsx`, `setBriefingFlag`), the briefing gets its "you are in cmd" lines. Useful alone.
2. **The server**: `cmd mcp` (stdio, pane resolution, no tools outside cmd), the tools moved out of `operator/` into one registry (`tools/`) that MCP, the CLI (`cmd tools`, `cmd tool`) and the Operator all read, renamed as in Names (`Tool`, `ToolContext`, `Caller`, `TOOL_ACCESS`, approvals), the drift tests.
3. **Registration**: one adapter per agent home beside `hooks.ts` (install, remove, state, shown with the hooks in Settings → Agents and `cmd hooks`), following the switch.
4. **The Operator's future**, after real use of 1–3.

## Open questions

- Default on or off for new installs: on is the point of the feature, off is what a user who never asked for an extra MCP server expects.
- Codex's hook trust by hash: does every hook change mean a new prompt for the user? (`hooks.ts` keeps the entry stable; check after phase 1.)
- Agents cmd hooks into today are Claude, Codex and Gemini. Which others get the server without the briefing (OpenCode, Copilot, Cursor, Amp), given they read the server's instructions inconsistently or not at all?

## References

Agent docs, checked 2026-10-13:

- Claude Code: MCP (scopes, plugins, instructions, tool search, output limits) https://code.claude.com/docs/en/mcp; CLI flags https://code.claude.com/docs/en/cli-reference; hooks (SessionStart, `additionalContext`, limits) https://code.claude.com/docs/en/hooks; env vars https://code.claude.com/docs/en/env-vars; managed MCP https://code.claude.com/docs/en/managed-mcp; IDE integration (lock file plus token) https://code.claude.com/docs/en/vs-code
- Codex: MCP https://learn.chatgpt.com/docs/extend/mcp?surface=cli; config and `-c` overrides https://learn.chatgpt.com/docs/config-file/config-advanced, https://learn.chatgpt.com/docs/config-file/config-reference; hooks https://learn.chatgpt.com/docs/hooks; AGENTS.md https://developers.openai.com/codex/guides/agents-md; the env a stdio server gets https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/utils.rs
- Gemini CLI: configuration and settings layers https://geminicli.com/docs/reference/configuration/; MCP https://geminicli.com/docs/tools/mcp-server/; hooks https://geminicli.com/docs/hooks/reference/; extensions https://geminicli.com/docs/extensions/reference/
- OpenCode: config layers https://opencode.ai/docs/config/; MCP https://opencode.ai/docs/mcp-servers/
- Cursor CLI MCP https://cursor.com/docs/cli/mcp
- Copilot CLI: MCP https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers; instructions https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions
- Amp MCP https://ampcode.com/manual/mcp.md
- Goose config https://goose-docs.ai/docs/guides/config-files

Protocols:

- MCP: transports https://modelcontextprotocol.io/specification/2025-11-25/basic/transports; tools and annotations https://modelcontextprotocol.io/specification/2025-11-25/server/tools; roots https://modelcontextprotocol.io/specification/2025-11-25/client/roots; lifecycle (2026-07-28) https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle
- Agent Client Protocol: session setup and `mcpServers` https://agentclientprotocol.com/protocol/session-setup; agents https://agentclientprotocol.com/overview/agents
- AGENTS.md https://agents.md

Not confirmed in the survey: how OpenCode, Cursor, Amp and Goose pass env to a stdio server; whether OpenCode, Copilot, Cursor, Amp and Goose read a server's `instructions`; where `instructions` lives in MCP 2026-07-28.
