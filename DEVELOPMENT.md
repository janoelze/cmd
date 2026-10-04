# Developing cmd

Research and design notes live in [`docs/`](docs/00-overview.md), starting with the overview.

## Layout

```
packages/protocol   shared types: data model, JSON-RPC API, settings schema, sidebar ordering
packages/core       the core process: PTYs (node-pty), agent tree, hooks, SQLite, settings, Unix socket
packages/cli        `cmd` — the same API from any shell, hook entry point, host-agent commands
packages/remote-crypto  Noise handshakes and framing for remote access, shared by the core and the web client
apps/desktop        Electron UI (React + xterm.js), a client of the core
apps/relay          the remote-access relay: forwards encrypted bytes between a Mac and its devices
e2e/                Playwright smoke test driving the real app
scripts/            postinstall, packaging, releases, icons, README screenshots
```

The core is a separate, long-lived process. The UI connects over a Unix socket and can reload or quit without killing terminals. The core and CLI run TypeScript directly on Node ≥ 22.18, so there is no build step.

## Develop

```sh
pnpm install
pnpm dev                     # Electron with HMR; starts a core if none is running
pnpm test                    # vitest: unit + real-PTY integration tests
pnpm typecheck
pnpm e2e                     # build, launch the app via Playwright, screenshots in .cmd-dev/shots
```

Development builds (`pnpm dev`, and `pnpm dist`, which packages "cmd dev") have a red icon and the name "cmd dev". They are the "dev" instance (`packages/protocol/src/instance.ts`): their own core and state in `~/Library/Application Support/cmd-dev` (socket in `$TMPDIR/cmd-dev`), so they never attach to the installed app's core and your real terminals. They share `~/.config/cmd` (settings, keybindings) with it and never update themselves. Setting `CMD_HOME` puts an instance's state, socket and logs in that folder instead.

`$CMD_INSTANCE` and `$CMD_HOME` decide which instance a process is; `$CMD_SOCKET` only decides which core a client (the CLI, hooks) talks to. Every pane sets `CMD_SOCKET` to its own core, so the app and the core drop it on startup, along with the rest of the pane's context (`CMD_PANE_ID`, `CMD_AGENT_ID`…). That's what makes `pnpm dev`, `pnpm e2e` and `pnpm core` safe to run in the installed app's terminals. As a second guard, `core.hello` reports the core's state dir, and the app never restarts a core that isn't its own. `pnpm icons` renders the red icon into `apps/desktop/build/dev` along with the normal one.

For a throwaway state, or to use `pnpm core` and the CLI from source against it:

```sh
export CMD_HOME=$PWD/.cmd-dev     # socket, SQLite and settings.json go here
pnpm core                         # or let `pnpm dev` start it
pnpm cmd ls
pnpm core:stop                    # stop the core of $CMD_HOME (without it: the dev instance's; --release: the installed app's)
pnpm core:stop --terminals        # … and its PTY host: its terminals close (they come back on the next start)
```

Cores are detached and outlive the app, and their terminals run in a PTY host (`packages/core/src/terminals/host.ts`) that outlives the core, so stopping or restarting a core keeps the terminals: the next core takes them over. A host exits by itself once it has neither a core nor terminals. After dev sessions hosts can pile up with their terminals' PTYs (macOS allows 511 in total). `pnpm core:stop-all` stops every dev and test core and host on the machine; the installed app's only with `-- --include-release`. `pnpm e2e` cleans up its own.

### Restore

Each pane is recorded in `cmd.sqlite` (`panes`, with the backend instance it runs in), and its screen is saved every 10 s while it changes (`pane_screens`, the normal buffer only, `restore.scrollback` lines). Agents are stored while they live. At startup (`packages/core/src/restore.ts`) the core takes over the terminals the host still runs, and resurrects the others under the same pane id: in the old folder, with the old screen and a "Restored" line. Agent sessions are resumed with their own command (`claude --resume`); any other command that was running (reported by the shell integration's preexec) is put on the command line and never run (bash can't prefill its command line, so there it goes into history: Up gets it). The zsh and bash integrations also keep each pane's own history (`$CMD_HOME/history/<pane id>.zsh_history` or `.bash_history`, written at each prompt, next to the user's own HISTFILE), and a resurrected pane loads it, so Up gives what ran there. fish has none: its history is per `$fish_history` name, and a name per pane would replace the user's history instead of adding to it. If the host dies while the core runs, the core starts another and does the same. Same ids mean the layouts in `Space.view` still fit.

Inside the Agent Safehouse sandbox, Electron needs `CMD_NO_SANDBOX=1`.

## README screenshots

`pnpm shots` builds the app and renders `docs/screenshots/<scene>-<light|dark>.png` (hero, canvas, search) against a throwaway core, with fake agents and a fake htop so the shots are repeatable and private. `node scripts/readme-shots/screenshots.mjs hero` re-shoots one scene without building.

## Packaging and releases

`pnpm dist` builds the development flavor, `apps/desktop/dist/cmd dev-<version>-arm64.{dmg,zip}` (`electron-builder.dev.yml`); CI packages releases with `electron-builder.yml`. The app ships the core's TypeScript source in `Contents/Resources/runtime` (staged by `scripts/stage-runtime.mjs`) and runs it with Electron's own Node, so no system `node` is needed.

CI (`.github/workflows/build.yml`) typechecks, tests and packages every push. `pnpm release 0.2.0` (or `patch`/`minor`/`major`) bumps the version, tags `v0.2.0` and pushes; CI builds the tag and publishes a GitHub release with the .dmg and .zip (a version with a `-`, like `0.2.0-beta.1`, is a prerelease). After packaging, CI checks the signature with `codesign --verify --deep --strict` (and `spctl` when Developer ID signed), so a release macOS would call "damaged" fails instead of shipping. `scripts/install.sh` is the one-line installer the README points to.

Windows builds (x64) come from the same tag: CI's `windows` job runs the tests and the e2e on Windows, packages an NSIS installer (per user, one click) and a zip, and checks that the packaged app starts. A separate `release` job publishes both platforms' files as one release. Windows builds aren't code-signed yet, so SmartScreen warns about a downloaded installer; `scripts/install.ps1` downloads it with PowerShell, which doesn't mark the file, so no warning appears.

### Updates

Installed apps update themselves from GitHub releases with electron-updater (`apps/desktop/src/main/updater.ts`). It reads `latest-mac.yml` (`latest.yml` on Windows) from the latest non-prerelease, so `-beta` tags never reach users. `electron-builder.yml` has the `publish: github` config that generates that file (and the `.blockmap`s for partial downloads), and CI uploads them with the release. Squirrel.Mac only installs an update whose signature matches the running app, so updating needs Developer ID signed releases, which ad-hoc signed builds can't do.

The `updates.mode` setting picks `auto` (download in the background, install on quit; the default), `notify` or `off`. The app checks 30 s after launch and every 4 hours, and logs to `update.log` in the logs folder (see Logs and crash reports).

An update replaces the app bundle while the old core keeps running. So the packaged app starts the core from a copy of the runtime in `$CMD_HOME/runtime/<build>` (the newest three are kept), and an old core never loads the new version's files. After an update the app shows the usual "core is outdated" prompt.

### Logs and crash reports

Each process logs to its own file (`packages/protocol/src/log.ts`): `core.log`, `ptyhost.log`, `main.log` (with the app pages' warnings and errors as `[renderer]`), `update.log`, and `core.out.log` for whatever bypasses the core's logger (Node's fatal errors). Files rotate at 5 MB, three kept. Release builds log to `~/Library/Logs/cmd`, development builds to `~/Library/Logs/cmd-dev` (Console.app shows both); with `$CMD_HOME` set it's `$CMD_HOME/logs`, and `$CMD_LOG_DIR` overrides all of them. `CMD_LOG_LEVEL=debug` adds debug lines (on by default in development builds). Log through `logger("scope")`, not `console`.

Crashes are written as JSON to `<logs>/crashes`: uncaught exceptions in the core (which then exits) and in main, unhandled rejections (logged, the process keeps running), TypeErrors and the like thrown by RPC handlers, renderers and GPU processes that die, uncaught errors in the app's pages, a core that dies of a signal, and Crashpad minidumps when main itself crashed. Each report's context has `machine`, a random UUID made on first use and kept in `machine-id` in the release state dir (`$CMD_HOME` when set), so release and dev builds share it; reports from before it existed get it when they're sent. The app (`apps/desktop/src/main/crash.ts`) sends them to a Discord webhook with home folders replaced by `~`, at most once a day per crash and ten an hour, and moves them to `crashes/sent`. The webhook is baked in at build time from `$CMD_CRASH_WEBHOOK`, which CI sets from the `CMD_CRASH_WEBHOOK` secret for tagged releases only. Development builds don't send unless `CMD_CRASH_WEBHOOK` is set when they run. People can turn sending off with `diagnostics.crashReports` (Settings → About).

Feedback (Help → Send Feedback…, or the speech bubble in the status bar) goes to a second Discord webhook from `apps/desktop/src/main/feedback.ts`, with the version and platform if the sender leaves that ticked. Like the crash webhook it is baked in at build time, from `$CMD_FEEDBACK_WEBHOOK` (the `CMD_FEEDBACK_WEBHOOK` secret, tagged releases only); development builds can only send when it is set when they run.

### Signing and notarization

Without signing secrets, CI ad-hoc signs the whole bundle (`-c.mac.identity=-`). It runs, but Gatekeeper blocks a downloaded copy until the user clicks Open Anyway in Privacy & Security (or installs with `scripts/install.sh`). To sign with Developer ID and notarize, which needs a paid Apple Developer Program membership:

1. **Certificate.** In Xcode → Settings → Accounts → Manage Certificates, add a *Developer ID Application* certificate (or create one at developer.apple.com → Certificates with a CSR from Keychain Access). In Keychain Access, export it with its private key as a `.p12` with a password.
2. **API key for notarization.** At appstoreconnect.apple.com → Users and Access → Integrations → App Store Connect API, create a key with the Developer role. Download `AuthKey_<id>.p8` (only possible once) and note the Key ID and Issuer ID.
3. **Secrets:**
   ```sh
   base64 -i DeveloperID.p12 | gh secret set MAC_CERT_P12_BASE64
   gh secret set MAC_CERT_PASSWORD               # the .p12 password
   base64 -i AuthKey_XXXXXXXXXX.p8 | gh secret set APPLE_API_KEY_P8_BASE64
   gh secret set APPLE_API_KEY_ID --body XXXXXXXXXX
   gh secret set APPLE_API_ISSUER --body <issuer uuid>
   ```
   Instead of the API key, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (from account.apple.com) and `APPLE_TEAM_ID` work too.
4. Release as usual. The tag build signs with hardened runtime and `build/entitlements.mac.plist`, notarizes and staples the app. A certificate without notarization credentials fails the build, because Gatekeeper would block that app anyway.

To check a release by hand: `spctl --assess --type execute -vv /Applications/cmd.app` should print `source=Notarized Developer ID`.

## Agent detection and hooks

The core detects agents in two ways, both ported from the ghostty-agents fork.

- **Foreground process.** A small native helper (`packages/core/native/procinfo.c`, built by `pnpm install`) reads each terminal's foreground process with its full argv. Agents are found even behind wrappers such as `bash …/safehouse … claude`, `sandbox-exec … claude` and `node …/codex`. The process start time is used to ignore stale hook status.
- **Hook status files.** Every pane is started with `GHOSTTY_AGENTS_SURFACE_ID=<pane id>`, so the hook already installed by the fork (`~/.claude/hooks/ghostty-agents-status.sh`) works unchanged. It writes `$TMPDIR/ghostty-agents/<pane id>/<Event>.json`, and the core watches that directory. The fork's `.zshrc` patch already passes the variable through safehouse.
  - State comes from the newest session only, and files older than the agent process are ignored.
  - The last prompt becomes the title fallback.
  - The current tool is shown only if its call came after the last prompt.

`cmd hook <kind>` (talks to the socket; `cmd hooks claude` prints its config) remains an alternative for agents without the shell hook.

## Notifications

One path for every source (`packages/core/src/notifications.ts`): agents needing input or finishing a turn, terminal bells (`\a`), notifications programs ask for with escape codes (OSC 9, OSC 777, kitty's OSC 99), commands that ran longer than `notifications.longCommand` seconds (from the shell integration's OSC 133 marks), and `cmd notify`. A terminal that wants you gets an attention marker in its title bar and sidebar row, and counts toward the Dock badge, until you look at it.

## Settings

The schema is `packages/protocol/src/settings.ts`, with flat dotted keys. User values go in `~/.config/cmd/settings.json`, or in `$CMD_HOME` in dev. The core watches the file, so edits apply live, including to running shells (`open` rules) and search (the indexer restarts). The exceptions are tagged in the UI and CLI: `shell.program`, `shell.login` and `shell.integration` affect new terminals only, and `ui.defaultView` only the first launch.

## Remote access

Design: [docs/13-remote-access.md](docs/13-remote-access.md). The core connects out to a relay (`apps/relay`) and serves each paired device's Noise session like a socket client (`packages/core/src/remote/`), held to the policy table in `remote/policy.ts`: every RPC method needs an entry there, so adding a method means deciding whether a phone may call it. Try it locally without the web client:

```sh
pnpm relay                                       # ws://127.0.0.1:8787
pnpm cmd settings set remote.relay ws://127.0.0.1:8787
pnpm cmd settings set remote.client https://client.test   # any URL until the web client exists
pnpm cmd remote on
pnpm cmd remote pair                             # prints the link, then asks you to approve
pnpm remote:device pair '<link>'                 # a pretend phone, in another terminal
pnpm remote:device call pane.list                # through the relay, end-to-end encrypted
pnpm remote:device watch                         # bootstrap, follow terminals, print events
```

`pnpm e2e:remote` walks the whole journey through the built app (pair from Settings, approve, the status bar indicator and its popover, the watched window's badge) with a local relay and a pretend phone; screenshots land in `.cmd-dev/shots/remote-*.png`.

The host key and route live in `$CMD_HOME/remote/host.json`, paired devices and the audit log in SQLite (`remote_devices`, `remote_log`), the pretend phone's identity in `$CMD_HOME/remote-device.json`.

## Status

**Done**
- Core: PTYs mirrored into headless terminals, OSC 0/2/7/9/777/133 parsing, launch commands typed once the shell is ready
- Terminals survive core restarts (PTY host) and come back after reboots and crashes, agents resumed
- Agents: detected from the foreground process's full argv (through wrappers), state from Claude/Codex hooks, Claude subagents as virtual children
- Host API: spawn, send, read, wait, kill (`--tree`)
- Transcript search (SQLite, indexed in a worker), resume from the palette and sidebar
- Settings and SQLite persistence
- UI: sidebar grouped by attention with search and recent sessions, focus, grid, strip and canvas views, browser, file, text and Markdown windows, palette, settings window, themes, notifications, Dock badge
- Packaging, CI and GitHub releases

**In progress**
- Remote access (docs/13): crypto, relay, core gateway, policy, `cmd remote`, and in the app the Remote Access settings page, the approval sheet and the status bar indicator are in; next are the web client (Now, tabs, terminals on a phone) and fit-to-phone

**Next**
- Plugin host (routines and monitors in the core)
- Codex hook install
- Bundle the CLI with the app
