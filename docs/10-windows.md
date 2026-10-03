# Windows

cmd started macOS-only. This is the plan for running it on Windows, and the record of what's done. Work happens on the `windows` branch; the `windows` CI job (`.github/workflows/build.yml`) is the scoreboard. It runs with `continue-on-error` until it is green, then becomes required.

## Status (2026-10-03)

The `windows` CI job is required: install, typecheck, unit tests, the Playwright smoke test against the built app, staging plus a boot check of the shipped core, and packaging (NSIS installer and zip, x64, unsigned). A tag releases both platforms' builds together.

Done: named pipes; PowerShell as the default shell; Windows process names; terminals that close at once; drive-letter paths (Markdown, Spaces); state in `%LOCALAPPDATA%\cmd`; the platform's own window frame and menu bar (Settings and Quit in File); Lucide icons for the SF Symbols the UI names (`apps/desktop/src/main/icons.ts`); a Windows Terminal-style keymap translated from the macOS one (`otherPlatformKey` in `shared/commands.ts`: ⌘X → Ctrl+Shift+X, ⌥⌘X → Ctrl+Alt+X, ⇧⌘X/⌃⌘X → Ctrl+Alt+Shift+X; plain Ctrl+letter stays with the shell), with hints in that form and the terminal leaving bound combinations to the menu.

Known limits: no CPU/memory per terminal and agent detection through hooks only (no procinfo yet); Magic windows can't run shell commands (no sandbox yet: the agent gets no `run` tool, sources are fetched); no PowerShell integration (OSC 7/133, `open`); the CLI isn't packaged and `cmd` collides with `cmd.exe`; the installer is unsigned (SmartScreen warns). Synthetic keys bypass the native menu, so CI checks the menu's accelerators, not a real key press; AltGr (Ctrl+Alt) layouts may lose characters to the Ctrl+Alt shortcuts.

## What CI can and can't tell us

CI on `windows-latest` covers the mechanics: install, typecheck, unit tests, the core's integration tests against real ConPTY terminals, packaging, and the Playwright smoke test driving the built app (with screenshots as artifacts).

It can't cover: how the keymap and title bar feel in daily use, agent detection against real logged-in Claude/Codex sessions, a user's own PowerShell profile, or SmartScreen on an unsigned installer. Those need one hands-on pass on a real Windows machine before calling it done.

## Phase 1: runs on Windows, PowerShell, hooks-only agent detection

- **Socket**: a named pipe (`\\.\pipe\cmd-<user>`, or derived from `CMD_HOME`) instead of `core.sock`. Skip the socket's mkdir, stale-file removal, chmod and unlink. Add a `core.shutdown` RPC, since `SIGTERM` is a hard kill on Windows.
- **Paths**: state dir in `%LOCALAPPDATA%\cmd`; no `"/"` splitting anywhere (`path.basename`, `fileURLToPath` for OSC 7); `~\` expansion; `C:\…` must not parse as a URL scheme; a shared path helper for the renderer; `cmd-file://` URLs that carry drive letters.
- **Shells**: default to `pwsh.exe`, then `powershell.exe`; no `-l`; `.exe`-aware shell and agent classification.
- **Processes**: `windowsHide` on the detached core; killing a pane kills its whole process tree.
- **Electron**: `titleBarStyle: "hidden"` with `titleBarOverlay`, and CSS room for the window controls on the right. The app-name menu only on macOS. "Show in Explorer" labels. Taskbar flash and overlay badge instead of the Dock.
- **Packaging**: node-pty's `win32-*` prebuilds staged, a copy instead of the symlink for `@cmd/protocol`, an NSIS installer and zip, a Windows packaging and release step in CI.
- **Tests**: integration tests that don't assume zsh, `/bin/sh` or `sleep`, and the smoke test running on Windows.

Agents are detected through hooks (`cmd hook` → `hook.ingest`) only, and there is no CPU/memory sampling.

Known: Windows children inherit every inheritable handle, so the detached core inherits Electron's stdout/stderr pipes. Anything waiting for those pipes to close (Playwright's `app.close()`, `pnpm dev` in a terminal) waits until the core exits. The smoke test waits for Electron's exit instead; a real fix means starting the core without inheriting handles (e.g. through `Start-Process`).

## Phase 2: parity

- **PowerShell integration**: a profile injected at startup with a `prompt` that emits OSC 7 and 133, an `open` function (token-checked, falling back to `Invoke-Item`), and the "first prompt" signal for typing commands.
- **Shell-aware quoting** for launching and resuming agents (`'…'` and `VAR=x cmd` are POSIX-only).
- **Keymap**: Windows defaults on Ctrl+Shift (as in Windows Terminal), so Ctrl+C/W/N/K/R… reach the terminal. The terminal's key filter and the shortcut hints follow the platform.
- **procinfo for Windows**: a native helper that walks the process tree from the shell (Toolhelp32), picks the foreground process heuristically (the newest non-shell descendant), reads command lines and samples memory and CPU.
- **CLI**: `cmd` collides with `cmd.exe`; it needs another name or a different shim on Windows.
