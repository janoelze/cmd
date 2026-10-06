# Changelog

What changed in each cmd release, newest first. cmd shows the releases since your last update in What's New. Written at release time by the changelog skill (`.claude/skills/changelog/SKILL.md`).

## 0.15.1 — 2026-10-06

### New

- **New… (⌘N).** One place for every new window and widget, windows first. Type a URL or a path to open it, or describe a widget to make it with Magic.

### Improved

- New Terminal is now ⌘T, and the top bar's + opens New….

### Fixed

- ↑ and ↓ in the command palette scroll the list along with the selection.

## 0.15.0 — 2026-10-06

### New

- **Journal.** A work log of each day, written by your AI provider from your agents, commits, releases and commands. Add it from the Widget Library.
- **`cmd journal`.** Agents can ask what happened this week, or where work was left, and get the day-by-day log as Markdown.

### Fixed

- Agents started outside cmd, even in a sandbox, no longer fail on cmd's hook.
- A `claude -p` run from an agent's terminal no longer replaces that terminal's agent.

## 0.14.4 — 2026-10-06

### New

- **Drag and drop.** Drag files from Finder or a file browser into a terminal to type their paths, into a file browser to move them, or anywhere else to open them.
- **Drag files out.** Drag a file browser's rows, or a window's title icon, into Finder, Mail or any other app.

### Improved

- Every move from a drag can be undone from its toast, and cmd asks before moving something an open window uses.
- Your home folder, disks and folders like Documents and Library can't be moved by accident, and cmd tells you why.
- Hold ⌘ while dropping a folder on a terminal to type `cd` and its path.
- Onboarding, Feedback, What's New and the Widget Library look like your windows, with a title bar.
- Dimmed windows keep a crisp outline that matches the sidebars.

### Fixed

- The Task Manager's column headers line up with their columns.
- A text window whose file was moved or deleted no longer shows an error.

## 0.14.3 — 2026-10-06

### Improved

- Settings descriptions are one short line each, with an info button on the few that need more.

### Fixed

- Number fields in Settings show their whole value next to the unit, like 10000 lines.

## 0.14.2 — 2026-10-06

### New

- **Resize windows from the keyboard.** ⌥⌘+ and ⌥⌘− make the selected window wider or narrower.

### Improved

- API keys are checked as soon as you paste them, with Get a Key right beside the provider.
- Onboarding, Feedback, What's New and the Widget Library have a cleaner look that matches your window settings.
- Text fields are roomier, with clearer edges.
- Agent notifications no longer end with how long the turn took.

### Fixed

- The space switcher says "Connecting…" while cmd starts, instead of showing an empty menu.

## 0.14.1 — 2026-10-05

### New

- **Resize to 1500 × 900.** A command in the palette and the Window menu that sets the window to that size, for consistent screenshots.

## 0.14.0 — 2026-10-05

Read PDFs in cmd, and four new built-in widgets.

### New

- **PDF viewer.** PDFs open in their own window, with search, page thumbnails, the outline and zoom. It stays on your page when the file changes.
- **Built-in widgets.** Commands lists what your terminals ran, Notifications keeps what cmd sent, Resources shows CPU and memory, and Timer counts down.

### Improved

- The backdrop behind your windows has a light grain, and windows cast softer, deeper shadows.
- Window outlines and focus rings no longer spill into the gap beside a sidebar.

## 0.13.3 — 2026-10-05

### Improved

- When cmd can't start, it offers to try again, check for updates, or show the log.

### Fixed

- Terminals and agents saved by an older version can no longer stop cmd from starting.

## 0.13.2 — 2026-10-05

### Fixed

- The app starts again when agents from before 0.13 were open, instead of saying "the core did not start".

## 0.13.1 — 2026-10-05

Publishes 0.13.0, whose build stopped before it was released.

## 0.13.0 — 2026-10-05

Dock any window as a sidebar, and watch YouTube in a widget.

### New

- **Sidebars.** Dock any window to the left or right of a Space: right-click its title bar and choose Make Sidebar.
- **File browser as a sidebar.** Docked, it shows a compact folder tree. Bookmark folders and files to get back to them.
- **YouTube widget.** Paste a link and the video plays in its own window.

### Improved

- A top bar holds the Space switcher, the view modes and New.
- Resize a strip window from either edge, with a grip that shows where you are.
- Sign-in pop-ups such as Google's work in browser windows.
- Focus mode keeps the window's title bar and frame.
- Fit on the canvas shows every window, even with both sidebars open.

### Fixed

- The file browser asks before moving files to the Trash.

## 0.12.0 — 2026-10-05

Agent notifications say what happened, and a session can be summarized in a click.

### New

- **Smarter agent notifications.** A notification says in one line what an agent did or wants. Turn it off in Settings → Notifications.
- **Session summaries.** Right-click an agent's title and choose Summarize Session to see what you asked for, what was done and what changed.

### Improved

- You get a notification when an agent stops on an error, such as a usage limit.
- Typing to an agent while it works keeps what it did in one turn.
- Tooltips appear at their new place instead of sliding across the window.
- Settings has one AI & Agents page, and About is now Updates & About.
- Choose how many past sessions the sidebar lists under Recent, in Settings → Appearance.

### Fixed

- Agents no longer stay marked as needing you after you answer or dismiss their question.
- The strip's dots follow the selected window when it's already in view.

## 0.11.1 — 2026-10-05

### Improved

- The strip shows a dot for each window in place of its scrollbar; click a dot to bring that window into view.

## 0.11.0 — 2026-10-05

Your agents connect to cmd by themselves, and cmd keeps a record of what they did.

### New

- **Agents connect by themselves.** cmd adds its hook to Claude Code, Codex and Gemini CLI, profiles included, and keeps a copy of each file it changes.
- **Agent history.** `cmd agents turns` shows what an agent did, turn by turn: the prompt, the files it changed and its last answer.

### Improved

- Agents you interrupt no longer stay marked as working.
- Transcript search finds Claude Code profiles kept anywhere in your home folder.

### Fixed

- Notifications that an agent is done show its final message again.

## 0.10.2 — 2026-10-05

The public usage stats are better protected against made-up numbers.

## 0.10.1 — 2026-10-05

The public usage stats no longer count cmd's own test builds as installs.

## 0.10.0 — 2026-10-05

Set up AI once for all of cmd, and keep your widgets in a library.

### New

- **AI setup.** cmd asks for an Anthropic or OpenAI API key when you first open it. Change it any time in Settings → AI.
- **Widget Library.** ⇧⌘L shows your widgets and the built-in ones. A widget you take off the desk stays there, ready to put back in any Space.
- **Agent Activity.** A built-in widget with every agent at a glance: who waits for you, who is working and what just finished.
- **Live Diff.** A built-in widget with the uncommitted changes in a project, updated as you work.
- **Peer briefings (beta).** With `agents.peers` on, each agent learns which other agents work in its repository and can message them.

### Improved

- Magic widgets use the newest model your key can use, unless you pick one in Settings → AI.
- Settings → Agents → Hooks connects Claude Code, Codex and Gemini CLI to cmd.
- Widgets have their own menu and their own section in the sidebar, apart from your windows.
- New Magic Widget is now New Widget with Magic, still on ⇧⌘M.

### Fixed

- An agent no longer shows as working again after it finishes while its subagents run in the background.

## 0.9.3 — 2026-10-05

### New

- **What's New.** After an update, cmd shows what changed since the version you had. Reopen it from the sparkles in the status bar or Help → What's New.

### Improved

- Updates arrive sooner: cmd checks for them every 30 minutes instead of every 4 hours.

## 0.9.1 — 2026-10-05

### Fixed

- Restart Core no longer leaves a second copy running, which made terminals reconnect over and over and could crash cmd.

## 0.9.0 — 2026-10-04

### Improved

- Magic widgets are laid out edge to edge like small apps, so they fit a tall strip window as well as a wide one.
- Magic windows are now called Magic widgets, in the menus, Settings and the CLI.

### Fixed

- Building a Magic widget no longer fails on its first file writes.
- Popovers stay attached to their button when their content grows.

## 0.8.2 — 2026-10-04

### Fixed

- Clicking the view modes in the status bar switches the view instead of sometimes dragging the app window.

## 0.8.1 — 2026-10-04

### New

- **Widget status and notifications.** A Magic widget can show a status line in its title bar and notify you when something changes. Mute it from its menu.
- **Dock icon in your theme.** The Dock icon takes the colours of the current theme.

### Improved

- Magic widgets can type a command into a new terminal, open a file in cmd, copy text or play a sound when you click them.
- Links and buttons in a Magic widget work only once its window is selected, so scrolling past widgets no longer opens pages by accident.

### Fixed

- Resizing the app window no longer scrolls the strip back to the selected window.

## 0.8.0 — 2026-10-04

### Improved

- Settings, the Task Manager and the other panels share one consistent set of buttons, fields, menus and dialogs.
- Agent status lights are small animated dot glyphs, one for each state: working, needs you, unseen, done and idle.

## 0.7.1 — 2026-10-04

### New

- **More themes.** Rosé Pine (Main, Moon, Dawn), Kanagawa (Wave, Dragon, Lotus), Everforest (Dark, Light), Ayu (Dark, Mirage, Light) and Tokyo Night Storm and Day.

### Fixed

- Magic widgets find tools installed with Homebrew, such as `gh`, when cmd was started from the Dock.

## 0.7.0 — 2026-10-04

### Improved

- New defaults: a pastel theme, a subtle window shadow and roomier spacing, while settings you changed stay as they are.

## 0.6.0 — 2026-10-04

### New

- **Magic widgets, rebuilt.** Widgets are checked before they show. Press ⌘E on one to ask for changes, restore an earlier version or see why its data fails.
- **Usage stats.** cmd sends anonymous counts of launches, window types, agents and crashes. Turn it off with `diagnostics.usageStats`.

### Improved

- A new browser window shows an empty view in your theme instead of a blank white page.
- The empty desk shows a small logo in the theme's dim text colour.
- Startup is faster, the terminal in view fills first, and terminals draw with WebGL by default.
- Idle cmd uses less CPU and memory: it checks quiet terminals less often and refreshes less while no window is open.

### Fixed

- Resizing a window in the strip no longer resets the widths of browser, files and text windows.
- Browser windows open `~` paths and plain file paths, and a page that fails to load no longer causes a crash.

## 0.5.3 — 2026-10-04

### New

- **Device sizes for browser windows.** Right-click a browser window → Device Size to show the page at a phone, tablet or desktop size.
- **Window styling settings.** Settings → Windows sets outline width and contrast, the drop shadow, how the selected window is marked and an outline for windows that need you.

### Improved

- The sidebar footer shows cmd's health, memory and CPU, and a click opens details, Restart Core and the Task Manager.
- Tooltips appear quickly in your theme, and show the shortcut where there is one.
- Tables in Magic widgets fill the window.
- The Settings sidebar has larger icons and more room between items.

### Fixed

- Selecting text in a terminal on a zoomed canvas lands on the right characters.

## 0.5.2 — 2026-10-04

### New

- **Unfocused dimming.** `ui.unfocusedDim` sets how much windows other than the selected one are dimmed, 10% by default.

### Improved

- Remote access has a proper phone layout, with terminals that fit the screen, a compose bar and extra keys.

## 0.5.1 — 2026-10-04

### Fixed

- The installed app starts again, which it couldn't in 0.5.0.

## 0.5.0 — 2026-10-04

### New

- **Remote access (beta).** Pair your phone in Settings → Remote Access to see what needs you and type into terminals from anywhere. You approve every device on your Mac.
- **Git in file windows.** File windows show each file's git status and the branch. Rename, duplicate, trash and create files from the keyboard.
- **Find in terminals.** ⌘F searches a terminal's scrollback. ⌘↑ and ⌘↓ jump between prompts, and ⇧⌘A copies the last command's output.
- **Clickable links and paths.** ⌘-click a URL or a file path in a terminal to open it, including `file:line:col` paths.
- **Task Manager.** Window → Task Manager shows what each part of cmd and each terminal uses, and can end a terminal.

### Improved

- Terminals show inline images and progress bars, and shell integration works in bash and fish too.
- Pasting several lines into a terminal asks first, and dropping a file types its path.
- Spaces have icons, and the Space switcher lists every open Space.
- Clicking in the command you are typing moves the cursor there.

### Fixed

- Neovim and fish 4 start in terminals that open in the background.

## 0.4.1 — 2026-10-04

Fixes to how cmd is tested before release.

## 0.4.0 — 2026-10-04

### New

- **Terminals survive restarts.** After a crash or a reboot, cmd reopens your terminals and resumes the agent sessions that were in them. Terminals also keep running while cmd updates.

### Improved

- ⇧↩ inserts a newline in Claude Code and Codex.
- Copy and Select All work in browser windows and Magic widgets.

### Fixed

- Closing a terminal while dragging in it no longer breaks dragging in other terminals.

## 0.3.9 — 2026-10-04

### Improved

- New Magic widgets read like terminal panes: one text size, a status line and aligned rows in side-by-side panes that fit any window size.

## 0.3.8 — 2026-10-04

### Improved

- The sidebar has a little more padding by default.

## 0.3.7 — 2026-10-04

### Improved

- Text fields have a softer focus ring, and the find panel, placeholders and checkboxes follow the theme.
- Settings → Appearance sets the sidebar's padding.
- New Magic widgets are flatter, with content straight on the background instead of boxed in cards.

## 0.3.6 — 2026-10-04

### New

- **Send feedback.** Help → Send Feedback… or the button in the status bar sends a note straight to the developer.

## 0.3.5 — 2026-10-04

### New

- **Where links open.** A setting picks whether links in Magic widgets, Markdown and browser pages open in a cmd browser window or your default browser.

### Fixed

- Open in Default Browser works again.

## 0.3.4 — 2026-10-04

### Fixed

- Clicking a link in a Magic widget opens a browser window instead of blanking the widget.

## 0.3.3 — 2026-10-04

### Improved

- ⌘⌫, ⌘← and ⌘→ delete the line and move to its start or end in terminals, like other macOS terminals.
- Settings → About shows update checks, download progress and a Restart to Update button.
- Right-click a Magic widget → Refresh Every to set how often it updates.

### Fixed

- A Magic widget that is rebuilt no longer misbehaves because of its earlier version's scripts.

## 0.3.2 — 2026-10-04

Fixes to how cmd is built and released.

## 0.3.1 — 2026-10-04

Fixes to how cmd is tested before release.

## 0.3.0 — 2026-10-04

### New

- **Untitled text windows.** File → New Text Window (⇧⌘E) opens an empty text window. ⌘S saves it to a file, and closing it with unsaved changes asks first.
- **Logs and crash reports.** cmd keeps logs in `~/Library/Logs/cmd` and sends crash reports with home folders hidden. Turn sending off with `diagnostics.crashReports`.

### Improved

- The Settings window is reorganized into pages like Appearance, Terminal and Agents, and keyboard shortcuts are recorded by clicking them.
- Changing a Magic widget remembers every earlier request, and a widget in a Space knows its project folder.

## 0.2.7 — 2026-10-04

### Improved

- Magic widgets use the provider, model and API key you choose in Settings, from Anthropic or OpenAI.
- A Magic widget shows only once it is drawn with its data, and Change, Refresh and Stop are in its right-click menu.

## 0.2.6 — 2026-10-03

### New

- **More agents in search.** Search finds Qwen Code and Copilot CLI sessions, and archived Codex sessions.

### Improved

- A ring in the search field shows indexing progress, and Settings → Search can rebuild the index.

## 0.2.5 — 2026-10-03

### New

- **Updates.** cmd installs new versions from GitHub in the background. `updates.mode` can only notify you or turn checks off, and cmd → Check for Updates… checks now.
- **About in Settings.** Settings → About shows the version, update status and cmd's processes, with buttons to restart, open logs and copy everything for a bug report.

### Improved

- The app is signed and notarized, so it opens without right-click → Open.
- ⌘↩ toggles focus from any view, and the strip returns to where it was.
- Copy Resume Command uses your configured agent command and config folder, and search finds sessions in more places.

## 0.2.4 — 2026-10-03

### New

- **Media in Magic widgets.** A widget can play audio and video or load images from sites you allow.

### Improved

- The strip scrolls natively, with macOS momentum and bounce.
- Switching Spaces slides the sidebar, and the Space switcher shows each Space's name on hover.

### Fixed

- Reloading the app no longer garbles Claude Code and other full-screen programs.

## 0.2.3 — 2026-10-03

### Improved

- The strip scrolls freely, without snapping, and has a real scrollbar.

## 0.2.2 — 2026-10-03

### Fixed

- The installed app starts again, which it couldn't in 0.2.0 and 0.2.1.

## 0.2.1 — 2026-10-03

### Fixed

- Magic widgets follow theme changes, including ones that draw on a canvas.

## 0.2.0 — 2026-10-03

### New

- **Magic widgets.** Press ⇧⌘M and ask for what you want to see, and an agent builds a live widget for it in your theme. It refreshes on its own without calling the model.
- **Spaces.** A Space is a folder you work in, with its own terminals, agents and windows. Open a folder to switch to its Space; the others keep running.
- **Liquid Glass icon.** cmd has a new app icon.

### Improved

- Clicking and sideways scrolling work over browser windows and Magic widgets like over any other window.
- Windows take their places at launch without gliding in.

### Removed

- The Tools section in the sidebar.

## 0.1.0 — 2026-10-03

The first release.

### New

- **Terminals and agents side by side.** Terminals, browser, file, text and Markdown windows sit on one desk, arranged as a grid, a strip, a canvas or focused on one.
- **Agent-aware terminals.** Claude Code and Codex are recognised in any terminal, and the sidebar puts the ones that need you on top, with notifications and a Dock badge.
- **Terminals keep running.** Closing or reloading the app never ends your terminals.
- **Session search.** Search every past Claude Code and Codex session, and resume one.
- **The `cmd` command line.** Run `open` in a shell to open a file or folder on the desk, and use `cmd` to start, read and message agents.
