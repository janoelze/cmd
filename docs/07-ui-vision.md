# UI vision

> **Update 2026-10-03:** after seeing the first build, the visual direction moved to a **simple, solid dark theme in macOS system style**: no bevels, pinstripes, translucency or vibrancy. The pixel font (Pixelify Sans) was later retired too: all UI text uses the system font, and terminals use JetBrains Mono. The "Platinum" design-language section below is superseded. Layout, sidebar behaviour, view modes and the command palette still apply.

A playful take on 90s desktop software (Mac OS 8/9 "Platinum", a touch of BeOS and Win95), with a modern keyboard-first workflow, that still feels like a macOS app.

Clickable mockup: not built yet (planned as `docs/mockups/ui.html`).

## Layout

```
┌─ ● ● ●  ══════════════  cmd  ══════════════  [Focus|Tiles|Grid|Canvas] ⌘K ┐
│┌ Sessions │ Tools ┐ │                                                     │
││▸ NEEDS YOU (2)    │ │                                                     │
││ ● fix auth flow   │ │                 main view                           │
││ ● codex: migrate  │ │     focus / tiles / grid / canvas                   │
││──────────────────  │ │                                                     │
││ ◐ index rewrite   │ │                                                     │
││ ○ zsh ~/src       │ │                                                     │
││ ○ ssh gabriel     │ │                                                     │
│└───────────────────┘ │                                                     │
│ 4 agents · 1 working │                                                     │
└──────────────────────┴─────────────────────────────────────────────────────┘
```

## Left sidebar

**Two tabs** at the top: **Sessions** and **Tools**.
- Switch with ⌘⇧[ / ⌘⇧], or click.
- The sidebar can collapse to a thin strip of status lights (⌃⌘S).

### Sessions tab
Agents and plain terminal tabs share one list. A terminal tab is just a session with no agent.

**Ordering is attention first, then recency:**
1. **Needs you**: an agent waiting for input or permission, oldest wait first, so nothing starves.
2. **Done, not yet seen**
3. **Everything else**, by last activity

**List stability.** A list that reorders under your cursor is the classic failure of "sorted by recency".
- The order **freezes while the pointer is over the sidebar** or while you are navigating it with the keyboard.
- When the freeze lifts, rows *animate* to their new places instead of jumping.
- Pinned rows stay at the top, below "Needs you".

**Each row** has:
- a status light: orange = needs you, green = done, pulsing blue = working, hollow = idle shell
- a title
- a second line: the current tool, the question, or "done 3m ago"
- a small project chip, colored from a hash of the project name (carried over from the fork)

**Optional grouping:** a toggle switches from the flat attention list to grouping by project/branch, the fork's layout, for days with many repos.

**Keyboard:**
- ⌃⌘J: next session that needs attention
- ⌃⌘1–9: jump to a session by position
- Return: focus the selected session
- ⌘⌫: close the selected session

### Tools tab
Every plugin contributes a **panel**: a small "window" with a pinstriped title bar that collapses to that bar on double-click, like Mac OS 8's window shade.

A panel is built from **declarative UI primitives** that the plugin returns as data:

| Primitive | Use |
|---|---|
| `button` | Run a routine. It shows a busy state, and errors appear in a toast with "show output". |
| `toggle` | Two-state routine with state read from a monitor (e.g. VPN on/off) |
| `status` | A status light with label and value (`10.8.0.2 · 32ms`) |
| `select` | Pick one option (e.g. VPN profile) |
| `list` | Rows with actions (SSH hosts → Connect, Copy) |
| `meter` / `sparkline` | Numbers that change over time (disk, CPU, quota) |
| `log` | The tail of a routine's output, expandable into a full terminal |

Routines that need a terminal (sudo prompts, interactive output) open as a session, so they show up in the Sessions list like everything else.

## Main view
Four view modes in a segmented control in the title bar. Shortcuts ⌥⌘1–4, so they don't clash with the ⌃⌘ agent shortcuts.

| Mode | Behaviour |
|---|---|
| **Focus** | One session fills the view. The sidebar picks which one. |
| **Tiles** | Splits you arrange yourself (iTerm/Ghostty-style). The layout is saved per workspace. |
| **Grid** | Automatic: every session (or a filter, e.g. "agents only" or "this project") as an even grid. Good for watching several agents. Idle sessions shrink to cards. |
| **Canvas** | Infinite pan/zoom. Sessions are freely placed nodes, plus notes and tool panels. Zoomed out, nodes switch to **cards** (title, status, last lines); zoomed in, they become live terminals. Minimap in the corner. |

Clicking a session in the sidebar always reveals it in the current mode: it scrolls or pans to it and focuses it. It never forces a mode switch.

## Command palette (⌘K)
One input that searches everything. Prefixes narrow the search:

| Prefix | Searches |
|---|---|
| (none) | Everything, ranked: sessions, tools, commands, then transcript hits |
| `>` | App commands ("New terminal in…", "Switch to grid", "Rebuild index") |
| `@` | Open sessions |
| `#` | Tools and routines ("#vpn up") |
| `?` | Transcript search (FTS) with snippets. Return resumes the session or switches to it if it is live. |

The bottom of the palette shows keyboard hints. It's a 90s-style dialog box with a modern fuzzy list inside.

## Design language: "Platinum, but playful"

**Borrowed from the 90s:**
- **Bevels:** 1px light and dark edges on buttons, panels and the terminal well, so terminals sit *sunken* in the main view.
- **Pinstripes** on title bars and drag areas.
- **A pixel font** for labels and headings only. Body text uses the system font; terminals use your monospace font.
- **Chunky status lights** as the main way to show state.
- **Window shade** collapse for panels.
- **Dithered patterns** for empty states and the canvas background.
- **Optional sounds** (off by default): a soft click when an agent needs you.

**Kept modern and macOS:**
- Native traffic lights (`titleBarStyle: hiddenInset`) and native menus.
- System notifications and the Dock badge.
- A translucent sidebar background (Electron `vibrancy: "sidebar"`) under the bevelled controls.
- Smooth animations: reordering, view-mode changes, canvas zoom.
- Keyboard-first throughout.
- Light and dark mode: "Platinum" and "Platinum Night".

**Readability over nostalgia:**
- Terminals are plain: no pixel font and no effects inside the terminal well.
- The retro look lives in the frame around them.

**Theme tokens.** Everything is CSS variables:
- `--bevel-hi` / `--bevel-lo`
- `--chrome` / `--chrome-stripe`
- `--well`
- `--accent`
- `--state-needs`, `--state-done`, `--state-working`
- `--font-ui`, `--font-pixel`, `--font-mono`

A user stylesheet in `~/.config/cmd/theme.css` overrides any of them live, and plugins only use the tokens.

## Decisions this adds to the architecture
- The sidebar needs an `attention` score from the core. It is computed there (state + time spent waiting + seen flag), so the UI, the CLI and the Dock badge agree.
- Seen/unseen moves from memory into the SQLite store, so it survives restarts (fixes a fork limitation).
- The plugin UI primitive set above is the v1 plugin UI contract. Keep it small; anything larger is a canvas node or panel with its own webview.
- The LOD cards in Grid and Canvas use the core's headless terminal state (last N lines), so they cost no renderer. This fits the WebGL-pool plan in [02](02-terminal-foundations.md).
