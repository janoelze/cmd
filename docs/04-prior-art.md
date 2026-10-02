# Prior art

Apps that overlap with what we want, and what to borrow from each. Researched 2026-10-02. "(from memory)" marks a detail I didn't confirm from a primary source.

## Agent-terminal managers

| App | Stack / terminal | Plugin model | Agent awareness | License | Borrow |
|---|---|---|---|---|---|
| **cmux** (manaflow-ai) | Swift + AppKit on libghostty; reads your Ghostty config | Informal: skills plus agent hooks | Terminal notification codes (OSC 9/99/777); `cmux notify`; `cmux hooks setup` for Claude, Codex and OpenCode. Sidebar shows branch, PR, ports and the last notification. | GPL-3.0 (server parts BSL) | **Everything is scriptable over a Unix socket + CLI** (panes, keystrokes, screen reads, a built-in browser). Restore brings back layout and scrollback, then resumes agents by session ID. Closest to what we want, and a reason not to stay native. |
| **Superset** | Electron + React + xterm.js + node-pty | CLI, TS SDK, MCP server | Hooks report "done" and "needs attention"; one git worktree per agent | Elastic License 2.0 (source-available) | Shows that Electron + xterm.js is enough for this category. |
| **Conductor** | Tauri 2, React 19, TanStack, SQLite; agent processes on Bun | Closed | One worktree per workspace; drives agents through the Claude Code SDK | Proprietary | Lessons from their rewrite: stop idle agents and resume them on demand, virtualise long lists, keep slow work off the critical path. They had to fake Tauri's bridge to profile in Chrome. |
| **Nimbalyst** (formerly Crystal) | Electron | Extensions (details not confirmed) | Kanban of sessions, worktrees, iOS companion | MIT | Session-board UI. |
| **Claude Squad** | Go TUI on tmux + worktrees | — | Status per instance | AGPL-3.0 (one source says MIT) | Use tmux for persistence instead of rebuilding it. |
| **Sculptor** (Imbue) | Desktop app, Docker container per agent | — | Pairing mode syncs into the IDE | Unclear | Container isolation per agent. |
| **Vibe Kanban** | Rust + Node | — | A kanban board that drives several agent CLIs | Apache-2.0; community-maintained since Apr 2026 | Task-to-agent board. |
| Others | Agent Manager X (RAM/CPU per session), Agentrium (Tauri), Agent Deck (tmux TUI) | | | | All use the same detection approach: hooks plus a process scan. |

## General terminals

| App | Stack | Extensibility | Borrow / avoid |
|---|---|---|---|
| **Wave Terminal** | Electron + Go backend | Widgets; the `wsh` shell CLI controls the UI | **A separate backend process that owns sessions, plus a CLI that controls the UI from inside the shell.** |
| **Tabby** | Electron + Angular, xterm.js | npm `tabby-plugin` packages wired in through Angular providers | SSH profile handling. Its plugins are tightly coupled to internals. |
| **Hyper** | Electron + React/Redux, xterm.js | Redux middleware and component "decorators" | **Avoid this plugin style**: it broke on every internal refactor, and the project has stalled. |
| **Warp** | Rust, its own GPU UI | Workflows / Drive | Block-based command output. Client is AGPL-3.0 and the UI crates are MIT, so they can be read. |
| **WezTerm** | Rust, Lua config | Lua event hooks | **OSC 1337 `SetUserVar`**: a program can tag its terminal with state. Event-driven status bar. |
| **Kitty** | C/Python | Kittens (Python), watchers, remote control | Design of its remote-control protocol. |

## Canvas-style terminal apps
More detail is in [02-terminal-foundations.md](02-terminal-foundations.md#existing-canvas-terminal-projects-to-study).

- **TermCanvas**: Electron + xterm.js WebGL, with an agent status dot per node
- **nodeterm**: React Flow + xterm.js + tmux; solved zoom blur
- **Horizon**: Rust, egui and alacritty_terminal; minimap
- **Maestri**: native; agents are linked on the canvas
- **Catenary**: canvas IDE
- **p1rallels/infinite**: GhosttyKit surfaces on a SwiftUI canvas

None of them combines the canvas with good agent state, search and plugins, which is the gap this app fills.

## Plugin architecture patterns

| Pattern | Isolation | Developer experience | Verdict |
|---|---|---|---|
| **VS Code extension host** (from memory) | Plugins run in a separate Node process and talk to the app over RPC. Each plugin's `package.json` declares what it adds and when to load. | Excellent | **Copy**: declared contributions, lazy activation, a host process away from the UI. |
| **Raycast** | Node worker threads with per-extension memory limits; a custom React renderer produces native views | Excellent (TS + React) | Copy the idea that a plugin's UI is described as data the host renders, rather than plugins touching the DOM directly. |
| **Tabby** (Angular dependency injection) | None | Powerful | Too coupled. |
| **Hyper** (Redux middleware) | None | Fragile | Avoid. |
| **WezTerm / Kitty** (events + remote control) | Process boundary | Good for scripting | Copy for routines and monitors. |
| **Zed** (WASM components) (from memory) | Strong | Harder to write | Too much friction for a personal tool. |

## Takeaways
1. Every agent manager detects agents the same way: **agent hooks + a process scan + terminal notification codes**. Nobody has anything better, so build these three well.
2. Teams that started with Electron + xterm.js didn't hit a wall. cmux chose native for feel, not because it was necessary.
3. A **daemon + CLI + socket API** (cmux, Wave, Kitty) is the common thread among the extensible tools.
4. Plugins should declare what they add and run outside the UI process (VS Code, Raycast), not patch internals (Hyper, Tabby).

## Sources
- https://github.com/manaflow-ai/cmux
- https://cmux.com/agents
- https://news.ycombinator.com/item?id=46368739
- https://github.com/superset-sh/superset
- https://superset.sh/
- https://performance.dev/the-conductor-rewrite
- https://www.conductor.build/
- https://github.com/stravu/crystal
- https://nimbalyst.com/
- https://github.com/wavetermdev/waveterm
- https://deepwiki.com/Eugeny/tabby/9.2-plugin-development
- https://github.com/tsukasagenesis/tabby-ssh-sidebar
- https://github.com/vercel/hyper/releases
- https://en.wikipedia.org/wiki/Warp_(terminal)
- https://pkg.go.dev/github.com/walteh/claude-squad
- https://imbue.com/blog/sculptor-announce
- https://github.com/BloopAI/vibe-kanban
- https://github.com/maddada/agent-manager-x
- https://www.raycast.com/blog/how-raycast-api-extensions-work
