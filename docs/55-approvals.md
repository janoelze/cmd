# Approvals

**Status:** partly built (2026-10-13): the model, the sheet and Settings → Agents → Permissions; pairing still asks its own way.

> Status (2026-10-13), branch `agent-integration`: built as proposed, with these differences. The sheet is the kit's `ApprovalSheet` (`packages/ui/src/approval.tsx`, stories for every case), dressed as a window sheet after prototyping: the asker in its title bar with the workspace, "1 of 2" and a countdown at its right, the title under it, the reason in dim text (no quotes), the exact text or diff in a code well, how long a yes holds in Allow's menu (a split button, as VS Code's agent approvals: Allow and Return give Once, the menu This Session and Always, each with a line on what it covers), a switch beside Allow only where a yes comes in kinds (pairing: Control or View only), and a filled Allow (a filled red Run for risky actions; the kit now fills a sheet's last danger action everywhere). It opens centred, in every app window, for asks from any workspace (`lib/asks.ts`, `shell/Approvals.tsx`); the title bar's popover is gone. A yes "for this session" is the agent's (keyed by the agent, not its terminal), so a new agent in the same terminal starts over. Kept answers are keyed `<permission>` or `<permission>:<site>` (for a risky action the site is the action's name, kept at most for the session); old per-command keys are dropped. Closing a window the caller opened is "Show things", any other "Stop agents and close windows". `approvals.allow` and `approvals.denied` back Settings' "Always allowed" and "Recently denied" (`settings/AgentPermissions.tsx`). The camera, microphone and location ask uses the sheet (`SitePermissionSheet`, Esc still "not now" through `onDismiss`). Not moved: device pairing (`PairPrompt`, also shown inline in Settings), and the risky-run confirm in the Actions widget, which is the person's own action rather than someone asking. e2e: `approvals` (a `cmd tool` call opens the sheet, Return allows, Esc denies and the caller is told).

Read first: docs/54-agent-integration.md (agents calling cmd's tools), docs/51-operator.md (where the tools and their approvals came from).

## The idea in three sentences

> When an agent wants to do something in cmd that you should decide on, a sheet opens at once: who asks, what exactly would happen, and Allow on Return.
> What needs asking is decided per kind of action (type into terminals, act on web pages, open websites…), each set to Ask, Allow or Never in Settings → Agents → Permissions.
> An answer can hold for this once, for this agent's session, or always in this workspace, and every remembered answer is listed in that one place.

## What went wrong in docs/54

- **Asks were hidden.** A call waiting for you showed as "Claude asks…" in a title bar; the question only appeared if you clicked it. An agent waiting on an approval nobody sees looks stuck.
- **Remembered answers were too narrow.** Keys like `url:github.com`, `type:pnpm test`, `page:github.com:fill` meant the same kind of question came back site by site, command by command. Nobody thinks "allow typing `pnpm test`"; they think "let my agents type into my terminals".
- **There was nowhere to see or change them**, except a menu in the Operator's toolbar.
- **Six ways of asking.** Agent tool calls (a title-bar popover), the Operator (a card in its chat), a page wanting the camera (`SitePermissionSheet`), pairing a device (`PairPrompt`), running a risky Workspace Action (`ConfirmDialog`), opening a link in another app (a native alert, `main/open.ts`). Different words, layouts and keys for one question: may *who* do *what*, and should cmd remember?

## The user stories

1. *"Start the dev server and show it to me."* The agent runs the project's `dev` action and opens localhost beside itself. Nothing should ask: it's my project and my machine, and I see both windows appear.
2. *"Have another agent write the tests, and tell me when it's done."* Starting an agent shouldn't ask (it shows in the sidebar as a child, and has its own permissions). Messaging it later is typing into another agent's terminal: ask the first time, then let the agents talk for the rest of this session.
3. *"Fill in the form on the staging site."* Acting on a web page always asks first, and I can say "for this site, always".
4. *"Deploy it."* A risky action asks every time, whatever I set. Being asked to allow a deploy for ever is the wrong offer.
5. *I'm typing in a terminal when an agent asks.* The sheet comes up; a Return I was already typing doesn't approve something I haven't read.
6. *I'm tired of being asked about X.* Settings → Agents → Permissions, X: Allow. Or in the sheet: Always.
7. *I want to see what I allowed, and take it back.* The same page lists every remembered answer by workspace, and what was denied recently.
8. *An agent was refused.* It's told why in words it can act on: "The person said no: use the staging URL", or "Typing into terminals is off in cmd (Settings → Agents → Permissions)", not a bare error.

## What other tools do

Surveyed 2026-10-13 (sources at the end): Claude Code, Codex, Gemini CLI, GitHub Copilot (CLI and VS Code), Cline, Roo Code, Warp, Zed, Cursor; browsers, Android and macOS for permission prompts; the MCP spec.

- **The category is the unit.** Cline and Roo have toggles per category (read, edit, execute, browser, MCP), Roo labelled by risk; Warp gives each category Always ask / Always allow / Never (and "Agent decides"); Zed and Claude Code have allow/ask/deny per tool. Patterns go finer only where they read plainly: a command prefix, a host, a server.
- **Three scopes in the prompt: once, this session, always (in this project).** Codex: "just this once / for this conversation / in the future"; Copilot in VS Code: once, session, workspace, always; Chrome: "Allow this time / on every visit / Don't allow"; Android: "Only this time / While using the app / Don't allow". A scope wider than the project is set in settings, not offered in the prompt.
- **"Always" is only offered for what the prompt can show it covers** (Claude Code, Zed): no "always" for something the rule would reach further than the person can see.
- **Deny beats ask beats allow**, and a short list of dangerous things is never auto-approved however permissive the setting (Claude Code, Codex `forbidden`, Warp's denylist over Always allow).
- **"No, and tell it what to do instead"** is the standard third answer (Claude Code, Codex, Copilot): the reason goes back to the agent, which goes on.
- **One place to manage it all**, with where each rule came from and a way to revoke it (`/permissions`, Manage Tool Approval, Chrome's Site settings), plus "recently denied".
- **What people complain about:** prompt fatigue (Anthropic reports 93% of prompts approved), remembering too narrowly (the same prompt again and again), remembering too broadly or invisibly, rules that only live in JSON files, settings that don't do what they say.

So the industry standard is categories with Ask / Allow / Never, three scopes, a protected short list, denials with a reason, and one settings page. Classifiers that decide for you (Claude's auto mode, Codex's reviewer) are where it is heading, but they cost a model call per action; cmd's actions are few and visible, so categories with good defaults come first.

## The model

### Categories

Every tool call that changes something belongs to one category. A category's level is **Ask**, **Allow** or **Never**, set in Settings → Agents → Permissions (one settings key each, `agents.permissions.<category>`), for every agent and workspace.

| Category | What it covers (tools) | Default | Remembered for |
|---|---|---|---|
| See the workspace | look, read (terminals, windows, pages), search, events, wait | Allow | (not asked) |
| Show things | open a file, folder or terminal; focus; arrange; close windows it opened | Allow | (not asked) |
| Open websites | open a URL in a browser window. Pages on this Mac (localhost, the workspace's own servers) are always allowed | Ask | a site |
| Run project commands | run a Workspace Action | Allow | (risky ones: see below) |
| Start agents | agent start | Allow | |
| Type into terminals and agents | type (commands, keys), messages to another agent | Ask | the category |
| Act on web pages | page: click, fill, choose, submit, press | Ask | a site |
| Stop agents and close windows | agent stop; closing a window it didn't open | Ask | the category |
| Edit files | edit (models without file tools of their own: the Operator) | Ask | the category |

Never means the tool refuses at once and says so to the agent, naming the setting. Allow runs at once, still marked on the board.

### Never auto-approved

Whatever the levels say:

- **Risky Workspace Actions** (deploys, publishes: `WorkspaceAction.risky`) always ask, and the sheet offers Once and This session, never Always.
- **The deny-list** (root, piping downloads into a shell, credentials, force-push…) and **password, card and code fields** are refused outright, before any sheet; nothing can allow them.

### Scopes

The sheet answers for:

- **Once**: this call.
- **This session**: this agent's calls of this category (of this site, where it is remembered by site) until the agent exits. Kept in the core, not on disk.
- **Always in "<workspace>"**: kept per workspace (`remembered_approvals`, keyed by the category, and the site where there is one), listed in Settings, removable.

Setting a category to Allow in Settings is "always, everywhere". Deny is always for this once, with an optional reason; to stop asking with a no, set Never.

### How a call is decided

1. Refused outright (deny-list, sensitive field)? Refuse.
2. The category's level is Never? Refuse, naming the setting.
3. Risky Workspace Action? Ask (Once, This session).
4. Level Allow, or a remembered answer for this session or this workspace? Run.
5. Otherwise ask.

The access table (`TOOL_ACCESS`) stays underneath: a method a tool may not call is never reachable, whatever is allowed.

## The sheet

One sheet for every approval, built once in the kit and used for agents' tool calls, the Operator, web pages' permissions, pairing and risky actions.

```
┌──────────────────────────────────────────────────────┐
│ ◉ Claude “Bug hunt”  ·  demo                    1 of 2 │
│                                                      │
│ Type in the terminal “tests”                         │
│ “Re-running the failing test to see the error”       │
│ ┌──────────────────────────────────────────────────┐ │
│ │ pnpm vitest run src/math.test.ts  ⏎              │ │
│ └──────────────────────────────────────────────────┘ │
│                                                      │
│ Allow  [ Once | This session | Always in demo ]      │
│                                                      │
│ Deny and Say Why…                  [ Deny ] [ Allow ⏎ ]│
└──────────────────────────────────────────────────────┘
```

- **It opens at once**, near the top of the window that shows the workspace, over a light scrim; the window it would act on keeps its ring, visible behind.
- **Who asks** first: the agent's icon and name, and the workspace. The **title** says what, as people say it ("Type in the terminal “tests”", "Open github.com", "Fill “Search” on staging.example.com"). The agent's own line on why, quoted, under it. **Exactly what would happen** in a code block: the text and keys, the full URL, the element and the value, the diff.
- **Scope** as a segmented control under it, Once by default; This session and Always only where they apply.
- **Return allows** (Jan, 2026-10-13: most asks get a yes). One guard: a Return within 300 ms of the sheet appearing is ignored, so an Enter already being typed into a terminal doesn't approve unread. **Esc denies.** "Deny and Say Why…" opens a field; its text goes back to the agent.
- **Several at once** queue: "1 of 2", oldest first, one sheet. A call that ends while waiting (its agent exited, the pane closed) leaves the queue.
- **Answered on another device or by the Operator's chat**, the sheet closes.
- No answer in 15 minutes is a no, and the agent is told so.

### In the kit

- **`ApprovalSheet`** (packages/ui): who (icon, name, context), title, why, exact (a node: code block, diff, URL), choices (the scopes, or any labelled choices: pairing's View only / Control), the primary action, Deny with a reason, a queue position, an expiry countdown, a danger tone (risky actions). A story per case: a terminal command, a URL, a page fill, a risky action, a device pairing, a queue.
- **One ask queue in the app** (`renderer/src/lib/asks.ts`): every approval, from the core (tool calls: `tool.acting` with an approval, `approvals.waiting` after a reconnect) and from main (site permissions), goes through it; one sheet at a time, beside `shell/sheets.ts` (an ask waits for nothing; a palette open over it goes behind it).
- `main/open.ts` keeps its native alert: it has to work with no window open, and main decides alone there.

### On the board

- The ring and the title bar's "Claude: Running the tests" stay as they are.
- While a call waits, the window it would act on says "Claude asks…" in its title bar, and a click brings the sheet back to the front.

## Settings → Agents → Permissions

```
Permissions                                   Ask · Allow · Never
  Open websites                               [ Ask   ▾ ]
  Type into terminals and agents              [ Ask   ▾ ]
  Act on web pages                            [ Ask   ▾ ]
  Stop agents and close windows               [ Ask   ▾ ]
  Run project commands                        [ Allow ▾ ]   Risky ones always ask.
  Start agents                                [ Allow ▾ ]
  Show things                                 [ Allow ▾ ]
  Edit files (the Operator)                   [ Ask   ▾ ]

Always allowed
  demo        Type into terminals and agents            ✕
  demo        Open websites: github.com                 ✕
  cmd         Act on web pages: staging.example.com     ✕

Recently denied
  12:04  Claude “Bug hunt”  Open evil.example.com  “not that”   [Allow from now on]
```

Each level is a settings key (`agents.permissions.web`, …), live as every setting is, and in `cmd settings`. "Always allowed" is `approvals.list` across workspaces with `approvals.forget`; "Recently denied" is new (`approvals.denied`, from the tool.call log).

## What changes

**Core** (`packages/core/src/tools/`):

- `Approval` gets its `category` and, where it is remembered by site, its `site`; the per-call keys go (`type:pnpm test`, `send:claude`, `keys:…`, `page:site:fill`, `run:id`, `edit:dir`).
- `approvals.ts` decides as above: levels from settings, session answers per caller (in memory), workspace answers in `remembered_approvals` keyed `<category>` or `<category>:<site>`. Old keys are dropped; they were remembered for a week of the Operator's life.
- `approvals.answer` takes `scope: "once" | "session" | "always"` in place of `remember`; `ToolActivity.approval` says which scopes it offers. A protocol change, so `PROTOCOL` goes to 3 (docs/54's 2 hasn't shipped: one bump if they ship together).
- Never: refused with the category's name and the settings path.
- `approvals.denied`: recent denials from the `tool.call` events.

**Protocol**: `agents.permissions.*` in `SETTINGS_SCHEMA` (enum ask/allow/never, labels), placed in Settings → Agents.

**Renderer**: `ApprovalSheet` in the kit with stories; `lib/asks.ts`; the title-bar popover (`ActingApproval.tsx`) goes; Settings → Agents → Permissions; `SitePermissionSheet`, `PairPrompt`'s sheet and `ActionsView`'s risky-run confirm move onto `ApprovalSheet`.

**The Operator** asks through the same sheet; its chat card shows the step as waiting, without buttons of its own.

## Plan

1. **The sheet in the kit**: `ApprovalSheet` with its stories, prototyped in the UI Workbench with Jan (the prototype skill) before anything uses it.
2. **The model in the core**: categories, levels, scopes, the decision order, Never, the new `approvals.answer`; tests per category and scope.
3. **Asking**: `lib/asks.ts`, agent and Operator calls through the sheet, the popover gone, the Return guard; e2e: a tool call that asks opens the sheet, Return allows it, Esc denies.
4. **Settings → Agents → Permissions**: levels, always allowed, recently denied.
5. **The other asks move onto it**: site permissions, pairing, risky actions.

## Success criteria

- [x] A call that needs the person opens the sheet at once, in the window showing its workspace; Return allows it (but not within 300 ms of it opening), Esc denies it, "Deny and Say Why…" sends the reason to the agent.
- [x] Each category in the table has a level in Settings → Agents → Permissions and in `cmd settings`; Never refuses at once with a message naming the setting; Allow runs without a sheet.
- [x] This session holds until the agent exits (test); Always holds in its workspace only, shows under "Always allowed", and ✕ makes it ask again.
- [x] A risky Workspace Action asks every time and never offers Always; the deny-list and sensitive fields never reach the sheet.
- [x] Two asks at once show as "1 of 2" in one sheet; one whose agent exits leaves the queue.
- [ ] (2026-10-13: the camera/microphone ask does; pairing not yet; the risky-run confirm stays a confirm) The camera/microphone, pairing and risky-run asks use the same sheet.
- [ ] `pnpm typecheck && pnpm test && pnpm e2e` pass; the stories render in the Workbench.

## Open questions

- Per agent as well as per category ("Codex may type into terminals, Claude not")? Not in this round: one table, every agent.
- Presets ("Ask for everything", "Recommended", "Allow all but the risky") over the levels, like Warp's profiles? Easy to add later if one table is too fiddly.
- A model deciding the Ask cases (Claude's auto mode, Codex's reviewer)? Not now: it costs a call per action, and the defaults should leave few asks.

## References

- Claude Code permissions https://code.claude.com/docs/en/permissions, modes https://code.claude.com/docs/en/permission-modes, auto mode https://www.anthropic.com/engineering/claude-code-auto-mode
- Codex approvals and security https://learn.chatgpt.com/docs/agent-approvals-security, prompt labels https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/approval_overlay.rs, execpolicy https://github.com/openai/codex/blob/main/codex-rs/execpolicy/README.md
- Gemini CLI policy engine https://geminicli.com/docs/reference/policy-engine/, MCP https://geminicli.com/docs/tools/mcp-server/, trusted folders https://geminicli.com/docs/cli/trusted-folders/
- VS Code agent approvals https://code.visualstudio.com/docs/agents/run/approvals; Copilot CLI https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli
- Cline https://docs.cline.bot/features/auto-approve; Roo Code https://roocodeinc.github.io/Roo-Code/features/auto-approving-actions; Warp https://docs.warp.dev/agents/capabilities/agent-profiles-permissions.md; Zed https://zed.dev/docs/ai/tool-permissions; Cursor https://cursor.com/docs/agent/security/run-modes
- Chrome one-time permissions https://developer.chrome.com/blog/one-time-permissions; Android https://developer.android.com/training/permissions/requesting
- MCP tools https://modelcontextprotocol.io/specification/2025-06-18/server/tools, elicitation https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation
