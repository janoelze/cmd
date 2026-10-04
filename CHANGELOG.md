# Changelog

What changed in each cmd release, newest first. cmd shows the releases since your last update in What's New. Written at release time by the changelog skill (`.claude/skills/changelog/SKILL.md`).

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
