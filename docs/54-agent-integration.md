# Agent integration

**Status:** partly built: phases 1–5 (the switch, one tool registry, agent callers, `cmd mcp` and `cmd tools`, registration), 2026-10-13; phase 6 (retiring the Operator) is Jan's call. Left of the success criteria: Jan watching a real session, the CHANGELOG entry (written at release), the Discord ideas marked done, and the Operator's registrations, which go when it does.

> Status (2026-10-13), branch `agent-integration`: built as planned, with these differences. **The switch**: `agents.integration`, off by default, in Settings → Agents → Setup under the hooks (`agents.peers` carries over). The briefing (`agents/briefing.ts`) says the pane, its agent's name, the workspace and its folder, the agent's short id, and how to reach the tools: the "cmd" MCP server where it is in every home of that agent (`AgentSetup.serves`), else `cmd tools`/`cmd tool`; on a prompt it carries the peers when they changed and the reports. **The registry**: `packages/core/src/tools/`, by area: `workspace.ts` (look, read, search, events), `actions.ts` (run), `agents.ts` (agent, wait, type), `edit.ts` (edit, for models only: `Tool.for`), `windows.ts` (open, close, focus, arrange), `pages.ts` (page); `kit.ts` (`Tool`, `ToolContext`, `Caller`, `Approval`), `access.ts` (`TOOL_ACCESS`, `QUIET_EVENTS`), `approvals.ts` (waiting and remembered, `remembered_approvals`; the Operator's `operator_grants` move there once), `reports.ts`, `runner.ts`, `feature.ts`. Each tool declares the methods it `calls`; MCP's `readOnlyHint` (every call `read`) and `destructiveHint` (any `confirm`) come from them and `TOOL_ACCESS`, and `tools.test.ts` checks the declared calls cover the code's. **Agent callers** (`tools/runner.ts`, `tools.list`, `tools.call`): the caller is the pane, proven by `CMD_PANE_TOKEN` (`PaneManager.trusts`); without it only the tools that read; when `CMD_PANE_ID` didn't reach the server, the core finds the pane from the pids the server sends (its ancestors). Acts run one at a time per caller. A call that must ask waits for the person in cmd: `tool.acting` puts it on the title bar of the window it would act on (else the caller's), whose status opens Allow / Deny / Always Allow (`shell/ActingApproval.tsx`, the kit's `ChatApproval`); the person is notified from the caller's terminal; `approvals.waiting` gives them again after a reconnect; no answer in 15 minutes is a no. The Operator's steps use the same marks (`lib/acting.ts` replaced its own). An agent started by an agent is its child and starts in its caller's folder (found with a real Claude: in the Home workspace it had started in the home folder, at a trust prompt). `wait` takes `until: "reports"`. Agents get no `edit` (they read and write files with their own tools); `open` is for showing the person something: `kind: "file"` (was `path`) puts a file in cmd's editor, at a `line` if given, and `read`'s `path` is for callers without file tools. **The surfaces** live in the CLI, not `tools/mcp.ts`: `packages/cli/src/tools.ts` (`cmd mcp`, `cmd tools`, `cmd tool`), a process the agent starts, like `cmd hook`; the core side is `tools.list`/`tools.call`. `cmd mcp` answers in the client's MCP version when it knows it (2024-11-05 to 2025-11-25), runs calls side by side, and outside cmd, with no core, or with the switch off lists no tools and gives no instructions. **Registration** (`agents/mcp-config.ts`) edits the user configs for all three agents rather than running `<agent> mcp add` (testable, no agent CLI needed in the core): Claude's `.claude.json` (the profile's own; `~/.claude.json` for the default home), Codex's `[mcp_servers.cmd]` with `env_vars` and `tool_timeout_sec = 900`, Gemini's `mcpServers.cmd` with the pane's variables in `env` and a 900 s timeout. The entry names no build: every pane gets its instance's CLI as `CMD_CLI`, and the entry runs `/bin/sh -c 'exec "${CMD_CLI:-<the installed app's cmd>}" mcp'`, so one entry serves the installed app and every development build, and a dev build's panes reach its own code. The hook finds the briefings flag the same way (`$CMD_CLI` → its state dir), so a dev build's panes follow its own switch whichever cmd installed the hook. Testing a dev build: once the installed app has the entry and the hook, turning the switch on in the dev build is all; before that ships, Install in the dev build's Settings → Agents puts them in. Only an entry named "cmd" written by cmd is ever changed; the rest of a file stays byte for byte (tested). Like hooks, the switch adds and removes them only in the installed app; Install and Remove in Settings → Agents (and `cmd hooks install|remove`) take the server along in any build, and both show its state. Checked with real agents in a cmd pane (the server given by flag, not registered): Claude ran look, open (asked in cmd), agent, wait and read; Codex, with `env_vars`, ran look and open as its pane's agent; Gemini lists the server as connected and ran look and open. Not yet: a real interactive session with the server registered and the briefing, watched by Jan. Known limits: inside Agent Safehouse `ps` is not allowed, so finding the pane by ancestry works only outside it (the env is forwarded where agents filter it); a running Claude might write `.claude.json` back without the entry, which the next switch or Install restores.

Date: 2026-10-13. From two Discord ideas (2026-10-12 "agent connectivity: opt in/out of cmd announcing itself to agents with a global toggle", 2026-10-13 "cmd should expose MCP controls … the operator wastes API tokens") and Jan's take on them: the Operator (docs/51) does a job any coding agent could do, if it had cmd's tools and knew it runs inside cmd.

Read first: docs/08-host-agents.md (cmd as the orchestrator), docs/18-agent-activity.md (the hooks and agent homes), docs/51-operator.md (the tools and the access table this reuses).

## The idea in three sentences

> An agent started in a cmd terminal knows it runs in cmd: which pane and workspace it is in, which other agents work beside it, and what it can ask cmd to do.
> It can ask through cmd's tools, an MCP server every supported agent gets, the same methods the Operator calls: open a browser on the dev server, start a second agent, wait for it, arrange the board.
> One switch, **Agent integration**: agents either know about cmd or they don't.

What this replaces: the Operator's own model loop. The person already has an agent open, paid for and trusted; a second one in a widget that drives the first through the board costs tokens twice and feels less direct. What stays: the Operator's tools, its access table and the app round trips behind them (`windows/app-ask.ts`), now called by the agent the person already talks to.

## Why

- **Agents in cmd work blind to cmd.** A Claude or Codex session in a pane doesn't know it is in a workspace with a browser, a file tree, other agents and named actions beside it. It starts a dev server and tells the person to open localhost; it can't see that another agent is editing the same files; it reinvents with `sleep` loops what `cmd wait` does. Everything cmd knows about the workspace stops at the pane's edge.
- **The tools exist, behind the wrong caller.** The Operator proved the methods and tools work: opening windows, reading browser pages, starting and waiting for agents, arranging the board, with approvals and marks on the board. But only a second model in a widget can call them. The person has to switch to it, explain the task again, and pay for both models' tokens; "less magical", as the feedback put it.
- **The CLI alone isn't enough.** `cmd` is on every pane's PATH, but an agent that doesn't know about it never runs it, and one that does has to learn its flags from `--help`. Typed tools with descriptions are what agents use without being told.
- **Peer briefings showed the way.** The hook that tells an agent about its peers already reaches Claude, Codex and Gemini at session start. Saying more through it is cheap.
- **Users asked for control.** Not everyone wants cmd talking to their agents or adding an MCP server to their configs. One switch, and nothing left behind when it is off.

## Goals

- **Any agent in a cmd pane can use the workspace** as the Operator does today: open a browser on what it serves, start and message other agents and wait for them, read other panes, run Workspace Actions, arrange the board.
- **It knows without being told**: the person never has to explain cmd to their agent.
- **One switch** (`agents.integration`): on, agents get the briefing and the tools; off, they get neither, and cmd's entries leave their configs. Activity is captured either way.
- **One source**: the methods once, the tools once; MCP, the CLI and any later surface are generated from them and tested against them.
- **Safe by the same rules**: an access table enforced in the core, approvals for what types into another pane or acts on a page, the window acted on marked, whatever the agent's own approval said.
- **Works however the agent was started**: typed by hand, resumed by cmd, spawned by another agent.
- **No second model**: the Operator can be retired without losing any of it.

Not goals: writing to the user's instruction files or repository; a tool per method; supporting every agent from day one (Claude, Codex and Gemini first, the ones cmd's hook already reaches); ACP or running agents headless (cmd runs the agent's own TUI).

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

With its tools in every agent, the Operator's loop is a second agent doing what the first could, so it is on its way out (Jan, 2026-10-13). Nothing new builds on it; the shared pieces leave its folder first (phase 2), so retiring it later deletes `operator/`, its widget and its chat methods, and nothing else. Until then it keeps working, reading the same tool registry.

## Plan

Each phase merges on its own and leaves cmd working; each ends with `pnpm typecheck && pnpm test` and, where the UI changes, `pnpm e2e`.

1. **The switch.** `agents.integration` replaces `agents.peers`: the key in `SETTINGS_SCHEMA` (a stored `agents.peers` carried over in `settings-migrations.ts`), Settings → Agents in `layout.ts` (the "Working together" section goes; `SettingsWindow.tsx` puts the hooks block beside the new key), `setBriefingFlag` in `agents/setup.ts` following it. The briefing gets its "you are in cmd" lines (pane, workspace, the CLI) beside the peers, in `agents/peers.ts` or a `briefing.ts` next to it. Done when: an agent started with the switch on is told it runs in cmd, with it off hears nothing, and status, turns and needs-input work either way.
2. **One tool registry, renamed.** A move with no change in behaviour: `operator/tools.ts`, `window-tools.ts`, `page-tools.ts`, `tool-kit.ts`, `board.ts`, `access.ts` and `deny.ts` go to `packages/core/src/tools/` under the names in Names (`Tool`, `TOOLS`, `ToolContext`, `Caller`, `TOOL_ACCESS`, `Access`, `QUIET_EVENTS`, approvals, reports, the acting mark). The Operator imports them from there. Protocol: `operator.answer`, `operator.grants`, `operator.revoke` become `approvals.answer`, `approvals.list`, `approvals.forget` (a renamed method bumps `PROTOCOL`), `OperatorGrant` becomes `RememberedApproval`; the `operator.tool` event becomes `tool.call` in a `tools` data class, with old `operator.tool` events still read as tool calls. The drift tests land here: every method a tool calls is allowed in `TOOL_ACCESS`, descriptions under a budget. Done when: the Operator behaves as before and nothing outside `operator/` names it.
3. **Callers other than the Operator.** `ToolContext` for a pane's agent: the caller from the pane (the acting mark names the agent, approvals that must ask in cmd show on the window acted on), reports delivered to the agent that started the work (the hook's `UserPromptSubmit` context, or `wait`). No `edit` tool for agents. A core method to call a tool by name for a caller (`tools.list`, `tools.call`), with the access table checked in the core. Done when: a test calls every tool as an agent caller against a `Core` with fake PTYs.
4. **The surfaces.** `cmd mcp` (`tools/mcp.ts`): a stdio MCP server over `tools.list` and `tools.call`, resolving its pane from `CMD_PANE_ID`, else its process ancestry (`agents/procinfo.ts`); annotations from `TOOL_ACCESS`; `instructions` under 500 characters; no tools outside cmd or with the switch off. `cmd tools` and `cmd tool <name> '<json>'` in the CLI, from the same list. Tests: the MCP list and `cmd tools` equal the registry; `registries.test.ts` adds "every tool is reachable from MCP and the CLI". Done when: a real Claude, Codex and Gemini in a cmd pane, with the server added by hand, open a browser and start an agent through it.
5. **Registration.** One adapter per agent home beside `hooks.ts` (`agents/mcp-config.ts` or similar): install through the agent's own `mcp add` at user scope where it has one, else edit the user config as `installHooks` does; forward `CMD_PANE_ID`, `CMD_SOCKET`, `CMD_PANE_TOKEN` where the agent filters the env; remove on switch off. Its state shown with the hooks (Settings → Agents, `cmd hooks`). The briefing mentions the server only in homes where it is registered. Done when: turning the switch on and off adds and removes the entry in every home cmd knows, and leaves the user's other servers untouched.
6. **Retire the Operator**, Jan's call after real use of 1–5: delete `operator/` (service, conversations, prompt, rules), its widget type and Ask Operator… command, and the `operator.*` chat methods (a `PROTOCOL` bump); its kit chat components stay if anything else uses them. Its conversations stay in the database until the next data cleanup, or are dropped with it.

## Success criteria

The plan is done when all of these hold. Each is checkable by an agent; where a check needs a real agent or Jan's eye, it says so.

**The switch**
- [x] Settings → Agents has one "Agent integration" switch and no "Tell agents about each other" row; `cmd settings` lists `agents.integration` and not `agents.peers`; a settings.json with `"agents.peers": true` loads as `agents.integration: true`.
- [ ] (2026-10-13: unit tests on the hook output; real sessions ran the tools with the server given by flag, not yet with it registered and the briefing in their transcript) Switch on: a new Claude, Codex and Gemini session in a cmd pane gets a briefing naming its pane, its workspace and the `cmd` tools (unit test on the hook output per agent; one real session per agent, its transcript showing the context).
- [x] Switch off: the same sessions get no briefing, the server lists no tools, and cmd's MCP entries are gone from every agent home cmd knows (`cmd hooks` shows them absent); cmd's hooks are still installed and an agent's status, turns and needs-input still show.
- [x] Outside cmd (a session in another terminal, `CMD_SOCKET` unset), the hook prints nothing and `cmd mcp` lists no tools, with the switch on.

**One source**
- [ ] (2026-10-13: only its registrations are left: `kernel/features.ts`, `windows/featured.ts`, `OperatorMethods`/`OperatorEvent` in `rpc.ts`, `operator.turn` and the old `operator.tool` in `events.ts`, the `operator` data class, its methods in the two access tables, `windows/builtin.tsx`, Ask Operator… in `shared/commands.ts`; they go with phase 6) Nothing outside `operator/` names the Operator: `grep -rni operator packages apps --include=*.ts --include=*.tsx`, excluding `operator/`, its widget and its protocol file, finds nothing; no shared identifier is named after MCP or RPC except the adapter `tools/mcp.ts`.
- [x] Tools are defined only in `packages/core/src/tools/`; `cmd mcp`'s `tools/list`, `cmd tools` and the registry match (test), and every tool is reachable from both (`registries.test.ts`).
- [x] Every method a tool calls is allowed in `TOOL_ACCESS` (test); a new method fails tsc until `TOOL_ACCESS` decides it.
- [x] Every tool description is under its budget and the server's `instructions` are under 500 characters (test).

**Agents using it**
- [x] A test calls every tool as an agent caller against a `Core` with fake PTYs, and an approval-needing call waits for an answer in cmd, not only the agent's own prompt.
- [ ] (2026-10-13: run by an agent with the server given by flag: Claude opened a browser, started a child agent and waited; Codex and Gemini ran look and open; Jan hasn't watched one yet) A real Claude, Codex and Gemini, each in a cmd pane with the switch on and no other setup, given "start the dev server and open it in a browser beside you" and "start a second agent on X and tell me when it is done", do both through cmd's tools: the browser opens next to their pane, the second agent shows in the sidebar as their child, and they report its end without polling the screen. (Run by an agent; Jan watches one.)
- [x] The pane resolves when the agent filters the server's env (Codex, with `CMD_PANE_ID` not forwarded): the server finds its pane from its process ancestry (test with a fake process tree).
- [x] The window acted on shows the acting mark naming the agent; a call `TOOL_ACCESS` marks `never`, or the deny-list refuses, fails with a message the agent can act on.
- [x] Turning the switch on and off leaves the user's own MCP servers and hooks in every agent config as they were (test on fixture configs, byte for byte outside cmd's entries).

**Wrap-up**
- [x] `pnpm typecheck && pnpm test && pnpm e2e` pass; `[lag]` lines in the core log show no new stall from the tools or the briefing.
- [ ] (2026-10-13: README, docs/51 and this status done; the CHANGELOG entry is written at release) README (features, CLI: `cmd tools`, `cmd tool`, `cmd mcp`), CHANGELOG and docs/51 updated; this doc's status says built, with what differs from the plan.
- [ ] The Discord ideas (2026-10-12 "agent connectivity", 2026-10-13 "cmd should expose mcp controls") are marked done with what users now do to get it.
- [x] Retiring the Operator (phase 6) is not required for the plan to be done; it is Jan's call afterwards, and when it happens `operator/` and its widget are deleted with no change elsewhere.

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
