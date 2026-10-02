# Prior work: the `ghostty-agents` fork

Source: `~/src/ghostty-agents` (fork of Ghostty). The agent sidebar adds about 4.66k lines across 29 files, almost all Swift. It touches upstream in only three places: one line in `TerminalController.swift`, one line in `SurfaceView_AppKit.swift`, and the README. This is an inventory of what to port.

Path shorthands used below:
- `AS/` = `macos/Sources/Features/AgentSidebar/`
- `GA/` = `ghostty-agents/`

## Features to carry over

### Sidebar
- Lists every agent across all windows, tabs and splits.
- Can be resized (160–480 px); double-click the edge to reset.
- Follows the terminal theme and its background opacity.

### Grouping by project
- Agents are grouped by git root. The app walks up to `.git` and follows worktree `gitdir:` files.
- The header shows the branch, or a short hash when detached, read from `.git/HEAD`.
- Folders collapse, and the collapsed state persists. A collapsed folder still shows its agent count and its most urgent state.

### Rows
Each row has two lines.

The title is the first of these that is available:
1. The terminal title, with spinner glyphs removed
2. The indexed session title
3. The last prompt
4. The agent name

The second line depends on the agent's state:

| State | Second line |
|---|---|
| Working | The current tool, e.g. "Editing X.swift" |
| Needs input | The question, in orange |
| Done | "Done", with how long ago |

### Status dots

| Dot | Meaning |
|---|---|
| Pulsing | Working |
| Orange | Needs input |
| Green | Done, not yet seen |
| Green ring | Done and seen |
| Gray ring | Running, with no hook data |

### Keyboard shortcuts
- ⌃⌘S toggles the sidebar.
- ⌃⌘J jumps to the next agent that needs attention: needs-input first, then done, oldest first.
- ⌃⌘1–9 jump to an agent by position.
- ⌃⌘K opens search.

### Context menus
- **Agent row:**
  - Show
  - Fork Session in New Tab or Split
  - Quit Agent
  - Copy Session ID
  - Copy Resume Command
  - Reveal Transcript
  - Open Folder in Finder
  - New Tab in Folder
- **Search result:**
  - Switch to Session
  - Resume in New Tab or Split
  - Fork in New Tab or Split

### Notifications and Dock badge
- A notification fires when an agent needs input, or goes from working to done. Clicking it focuses that terminal.
- Needs-input also bounces the Dock icon.
- The agent's own OSC 9/777 notifications for the same surface are removed so they don't show twice.
- The Dock badge shows how many agents need attention.

### Other
- **Project tab colors:** stable per project, from an FNV-1a hash of the name into a 7-color palette. Tabs you colored yourself are never changed.
- **Cat Mode:** pixel cats in the sidebar. The sprites load from Application Support because their license is unclear.
- **Status line:** e.g. "4 agents · 1 working · 1 waiting", plus indexing progress.

## Detecting agents and their state
State comes from two layers:
- a 1-second poll of the terminals' foreground processes
- FSEvents on the hook status files

### Layer 1: process inspection
Code: `AS/AgentProcess.swift`.

1. Take each surface's foreground PID.
2. Read the executable path and arguments with `sysctl KERN_PROCARGS2`.
3. Match known agent names against the basename of every argument and every path component. This catches agents behind `sandbox-exec … claude` or `node …/codex`.

Known names: claude, codex, gemini, aider, opencode, amp, cursor-agent, goose, crush, qwen, droid.

The process start time (`KERN_PROC_PID`) is used to ignore hook status left over from an earlier process.

### Layer 2: Claude Code hooks, keyed by a surface id
Each terminal starts with `GHOSTTY_AGENTS_SURFACE_ID=<uuid>` in its environment.

`GA/hooks/claude-status.sh` is registered for these events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop and PreCompact.

For each event the hook:
1. reads the payload from stdin
2. checks that the id looks like a UUID
3. writes `$DARWIN_USER_TEMP_DIR/ghostty-agents/<uuid>/<Event>.json` atomically, as `{agent, ts, event:<raw payload>}`

SessionEnd removes the directory.

Sandbox wrappers clear the environment, so they have to be told to pass the variable through: `safehouse --env-pass=GHOSTTY_AGENTS_SURFACE_ID`.

### Mapping events to states
Events are sorted by file modification time and filtered to the newest `session_id`. That handles `/clear` and resumed sessions in the same terminal.

| Event | State |
|---|---|
| SessionStart, Stop | done |
| UserPromptSubmit, PreToolUse, PostToolUse, PreCompact | working |
| Notification with `notification_type == idle_prompt` | done |
| Any other Notification | needsInput (`message` is the detail) |
| No hook data | running |

"Needs attention" means needs-input, or done since you last looked at that terminal.

## Search index
Sources:
- `~/.claude/projects/**.jsonl`
- `$CLAUDE_CONFIG_DIR`
- `~/.claude-profiles/*/projects`
- `~/.codex/sessions/**/*.jsonl`

The parser reads the JSONL loosely:
- **Kept:** titles (`ai-title`, `custom-title`, `summary`), user and assistant text, and tool-use inputs.
- **Skipped:** tool results, thinking, sidechain and meta messages.
- **Limits:** each text is capped at 20k characters.

The index is SQLite in WAL mode at `~/Library/Caches/ghostty-agents/sessions.sqlite`. Its tables:
- `files(path,size,mtime)` drives incremental re-indexing.
- `session_fts` is FTS5 with columns title, prompts, responses, tools and idents (identifiers split on camelCase, snake_case and path separators).
- `message_fts` holds one row per message, used for snippets.
- `fts5vocab` holds the vocabulary used for typo tolerance.

How a query is ranked:
1. Terms are prefix-matched and ANDed. `"phrase"` and `-exclude` are supported.
2. The score is BM25 with column weights 10/5/1/2/1.5, multiplied by a recency boost of `1 + 0.6·e^(−days/21)`.
3. If there are fewer than 40 hits, a second typo-tolerant pass expands terms through the vocabulary, allowing an edit distance of 1, or 2 for terms of 8 or more characters.

## Resume after restart
On every refresh the app writes `[{surface, session:{agent,id,cwd,configDir}, savedAt}]` to `~/Library/Application Support/ghostty-agents/running-agents.json`. It stops writing once the app starts quitting.

On the next launch, for sessions younger than 7 days:
1. If Ghostty's window restore brings the surface back with the same UUID and it is sitting at a shell prompt, the app types the resume command into it.
2. Sessions whose surface hasn't come back after 15 seconds open in new tabs.

Commands:
- `claude --resume <id>`, or with `--fork-session`. Prefixed with `CLAUDE_CONFIG_DIR=…` when the session isn't in the default profile.
- `codex resume <id>` or `codex fork <id>`.

The commands are typed into the user's shell rather than run directly, so shell wrappers like safehouse still apply.

## What ports as-is and what was tied to Ghostty
Ports as-is, as concepts and algorithms:
- the hook script and its installer
- the status store and event-to-state mapping
- process detection via sysctl
- the transcript parser, FTS index and fuzzy matching
- the restore file format and resume-command builder
- notification and badge logic, tab colors and Cat Mode

Tied to Ghostty, so the new app's terminal layer has to provide these:
- Putting environment variables into a new terminal's environment.
- The foreground PID per terminal, via `tcgetpgrp` on the PTY.
- The cwd and title, via OSC 7 and OSC 0/2.
- Listing terminals and focusing, closing, opening tabs and splitting them.
- Sending text and keys to a terminal, and giving it initial input.
- Tab colors.
- Notifications tagged with the terminal they came from.
- Restoring windows with stable terminal ids. Resume-in-place depends on this.

## Limitations to fix in the rewrite
- Detailed state exists only for Claude Code. Codex and the others always show "Running".
- A sandbox that clears the environment silently loses status unless the variable is passed through.
- Status files live in the temp directory and are lost on reboot. Only the latest file per event name is kept.
- Whether you've seen a finished agent is tracked in memory only.
- Resume-in-place depends on the host's window restoration.
- Menu shortcuts lose to Ghostty keybinds on the same key.
- **Costs of maintaining a fork:**
  - the bundle id and signing identity have to be pinned
  - Sparkle could swap the build back to official Ghostty
  - the Xcode Metal toolchain is required
  - merging upstream needs CI and a token
