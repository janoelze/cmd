# Architecture review 01: external research

Date: 2026-10-10. Pure external research (no cmd code read) on how large Electron apps are built and what current Electron guidance says, to give a reviewer testable yardsticks. Each claim carries a URL (listed in Sources). Coverage is uneven: official Electron and VS Code docs were fetched directly; Slack, Discord, 1Password, Figma, Arc, Raycast, Docker Desktop and Ghostty/WezTerm/kitty internals returned no usable primary sources and are NOT claimed here. Items marked (secondary) come from third-party summaries and should be verified before being relied on.

## 1. Process model

- Electron's own model: one main process, one renderer per BrowserWindow/embed, preload scripts bridging them [E-PROC]. For Node child work Electron says to prefer `UtilityProcess` over `child_process.fork`, mainly because it can open a `MessagePort` channel to a renderer; recommended for untrusted services, CPU-heavy work and crash-prone components [E-PROC].
- VS Code sandboxed its renderer (no Node), moved Node-dependent work out, contributed the utility process API to Electron for the extension host, and made terminals and file watching children of a shared process. Renderer-to-service traffic uses MessagePorts: the shared process makes a port pair and main forwards one end through the preload, keeping traffic off the main process that handles user input [VSC-SANDBOX].
- VS Code now ships a separate Agent Host process (local utility process via message port, or a remote server over JSON-RPC/WebSocket). Reasons given: shared sessions across windows, work continues with no client connected, isolation from busy extensions, remote execution next to the workspace. Earlier agent logic in the extension host was abandoned because its lifecycle suited extensions, not long autonomous work [VSC-AGENT].
- Version skew: the Agent Host Protocol uses immutable state plus pure reducers; the host is the source of truth; clients subscribe to URI channels (sessions, chats, terminals), get a snapshot then ordered actions, and on reconnect get missed actions or a fresh snapshot [VSC-AGENT]. The page does not describe version negotiation. Tailscale shows the failure mode: a "client version != server version" error when UI and service differ [TS-SKEW], and v1.66.0 added a GUI-vs-network-extension mismatch warning on macOS/iOS [TS-166] (secondary).

Implications for cmd:
- A detached core is a recognised pattern (VS Code Agent Host, tmux-like pty ownership); test that the UI-to-core contract is snapshot-then-ordered-events with resync on reconnect, not replay of raw streams.
- Check that skew is handled explicitly (hash/root check on hello is good; verify there is also a protocol version with a defined refuse/upgrade path, and that downgrade is covered).
- Heavy or untrusted work should be in utilityProcess/separate processes, not main; list what still runs in Electron main.

## 2. IPC and RPC

- Electron: only `postMessage` can transfer ports (not `send`/`invoke`); `MessagePortMain` needs `.start()`; messages queue until a listener is attached; a `close` event fires when the peer closes or is GC'd; use one port per request stream and close it to end the stream. With context isolation, main-process messages reach the isolated world only; relaying to the page needs `window.postMessage` and an `event.source === window` check [E-PORTS].
- Electron's performance guide: avoid synchronous IPC and `@electron/remote`; prefer async I/O [E-PERF].
- VS Code's extension API is RPC (JSON over IPC) with paired main/ext-host objects (secondary; the proxy-identifier mechanism lives in `extHost.protocol.ts`, not verified here) [MED-EXT]. AHP is JSON-RPC with reducers and URI-addressed subscription channels [VSC-AGENT].
- MCP Apps: JSON-RPC dialect over postMessage with `ui/initialize` handshake and an optional extension that must be negotiated between client and server [MCP-APPS] [MCP-SEP].
- Backpressure: xterm.js says `write` is non-blocking, processes about 5-35 MB/s, and its buffer is capped near 50 MB with data beyond that discarded; over a socket or websocket use end-to-end ACKs, because intermediate buffers are unpredictable [XT-FLOW].

Implications for cmd:
- Newline-delimited JSON-RPC is workable; check there is a max line size, per-subscriber outbound queue limits, and a drop/resync policy for slow clients (terminal output especially).
- Check every high-volume stream (pane output, fs.changed) has ACK or watermark flow control across socket, preload and renderer, not only PTY-to-core.
- Typed `Methods` map is good; verify events have the same typing and an explicit handshake carrying protocol version and capabilities.

## 3. Security model

- Electron's 20-item checklist: contextIsolation, sandbox all renderers, no nodeIntegration for remote content, CSP, permission request handler (default approves everything), `will-navigate` and `setWindowOpenHandler` limits, `will-attach-webview` hardening and no `allowpopups`, never pass untrusted input to `shell.openExternal`, validate IPC sender on every message, avoid `file://`, flip unneeded fuses [E-SEC].
- Sandbox: default since Electron 20; `nodeIntegration: true` or `sandbox: false` disables it per window. Sandboxed preloads get only a polyfilled `require` for `contextBridge`, `ipcRenderer`, `webFrame`, `webUtils`, `events`, `timers`, `url`, so no `net`. Docs advise delegating privileged work to main over IPC and avoiding `sandbox: false` unless necessary [E-SANDBOX]. Therefore a renderer that opens a Unix socket itself must run unsandboxed, and everything the page (or any embedded content sharing that process or preload) can reach becomes socket-capable.
- Fuses (flip at package time, before signing): `runAsNode`, `nodeOptions`, `nodeCliInspect` default on and most apps can disable; `embeddedAsarIntegrityValidation` and `onlyLoadAppFromAsar` recommended together; `cookieEncryption` needs a signed app on macOS; `grantFileProtocolExtraPrivileges` off if not using `file://` [E-FUSES]. Playwright needs `nodeCliInspect` not disabled to launch Electron [PW-ELEC].
- A 2026 advisory: contextBridge-exposed Promise-returning functions could allow an isolation bypass before Electron 39.8.9 / 40.9.2 / 41.2.2 / 42.0.0-beta.5 (secondary) [ADV-2026].
- VS Code replaced `file://` with a custom `vscode-file` protocol with HTTPS-like rules [VSC-SANDBOX].

Implications for cmd:
- `sandbox: false` is the documented exception, not the norm. Test: is the unsandboxed window only ever loading first-party bundled code with a strict CSP, and are browser/webview/Magic content in separate sandboxed contexts with no shared preload? Compare the cost of a main-process or utilityProcess proxy over MessagePort (VS Code's pattern).
- Check: IPC sender validation, permission handler on every session, `will-navigate`/window-open handlers, `openExternal` allow-listing, fuses flipped (runAsNode, nodeOptions, nodeCliInspect off in release; asar integrity on), CSP present, custom protocol instead of `file://`.
- `CMD_NO_SANDBOX` and similar escape hatches must be unreachable in release builds.

## 4. State management and data

- Daemon-as-source-of-truth with client subscriptions is VS Code's AHP design: snapshot then ordered actions, resync on reconnect [VSC-AGENT].
- Linear: local replica updated first, then synced; reported as server-assigned monotonic sync IDs, last-write-wins, no OT/CRDT, and clients replay deltas since a transaction id after offline (secondary, reverse-engineered) [LIN-SYNC] [LIN-TALK].
- Notion (SQLite WASM cache): per-tab worker, one active tab via SharedWorker and an infinitely held Web Lock; multi-tab writes corrupted data until single-writer; loading the library async fixed a load regression; on slow disks they race SQLite against the API [NOTION].
- Node's built-in `node:sqlite`: added v22.5, unflagged v22.13/v23.4, Stability 1.2 release candidate as of v25.7; has the Sessions/changeset API and backup; FTS5 not confirmed from the page [NODE-SQLITE].
- Electron says CPU-heavy work belongs in worker threads or separate processes [E-PERF].

Implications for cmd:
- Verify single writer to SQLite (core only), WAL mode, and indexing in a worker so the event loop never blocks (the `[lag]` watchdog is a good sign; check what its worst blocks are).
- Define the log's ordering key (monotonic sequence) and let clients resume from `since=<seq>`; confirm event types are versioned.
- Evaluate node:sqlite vs the current driver on native-module maintenance cost and FTS5 availability under Electron's Node.

## 5. Performance

- VS Code startup: most time went to V8 loading and parsing a roughly 11.5 MB minified workbench; they enable code caching on every start and drop caches on version change [VSC-SANDBOX]. ESM migration (1.94) reportedly cut the main bundle over 10% and sped up startup (secondary) [DEVCLASS].
- Electron checklist: bundle into one file, defer heavy `require`, avoid blocking main, `Menu.setApplicationMenu(null)` if unused, `requestIdleCallback`/Web Workers in renderers [E-PERF].
- V8 snapshots via electron-link: Atom claimed about 50% faster, but snapshot code cannot do I/O or use `Date.now`/random and bundlers conflict (secondary). Electron 43 reports the main process boots from an embedded Node startup snapshot with framework bundles and preloads cached as V8 bytecode; custom snapshots forfeit part of that win (secondary) [ELEC-43] [SNAPSHOT].
- xterm.js WebGL: the context may be lost (OOM, suspend); dispose and recover, with a DOM/canvas fallback [XT-WEBGL].
- Terminals: flow control via watermarks (example HIGH 100000, LOW 10000, keep HIGH at or below about 500K for keystroke responsiveness) [XT-FLOW].

Implications for cmd:
- Measure cold start in phases (main ready, window shown, first pane painted) with a regression budget; check bundling of main/preload and whether code cache is used.
- Count live WebGL contexts (browsers limit them) and verify context-loss recovery and that off-screen terminals release the renderer.
- Stalls: keep the 100 ms watchdog in CI via the perf stress script, and add a renderer long-task report.

## 6. Terminals

- VS Code has two persistence modes: reconnection after window reload (reattach to the running process and restore content) and revive after restart (relaunch with original environment); scrollback restored is configurable; images are not retained because serialization cannot carry them [VSC-TERM]. The xterm serialize addon is the usual route for content restore (third-party summary); a VS Code maintainer called keeping content one of the hardest parts [VSC-95183].
- Zed has an open RFC to move PTY ownership into a process outliving the editor, the tmux model [ZED-RFC].
- VS Code local echo for high-latency remote terminals activates over 30 ms threshold, excluded for vim/tmux [VSC-TERM].
- Flow control: see sections 2 and 5 [XT-FLOW]. Shell integration: VS Code documents its own sequences (the fetched page did not cover OSC 633/133 specifics, so not claimed).

Implications for cmd:
- A PTY host that outlives core and a headless xterm per pane matches the tmux/VS Code direction; test reattach after core crash, UI reload, and host protocol bump, with screen restored from the headless buffer and not raw replay.
- Check image/Sixel/kitty-graphics and alternate-screen behavior on restore, which VS Code documents as lossy.
- Verify output pacing at three layers (PTY pause, socket ACK, xterm write callback) with a `yes`-style test.

## 7. Extensibility and plugins

- Zed: procedural extensions compile to WebAssembly; a `granted_extension_capabilities` setting gates `process:exec`, `download_file` and `npm:install`, each scoped (command+args, host+path, package) [ZED-CAP]. Most extensions are declarative [ZED-EXT] (secondary).
- Obsidian: its published plugin guidelines describe no sandbox, only hygiene (avoid `innerHTML`, clean up listeners) [OBS]. Treat community plugins as fully trusted.
- MCP Apps (supported by Claude Desktop, VS Code Copilot and others): UI is a predeclared `ui://` resource rendered in a sandboxed iframe, with `_meta.ui.csp` and `permissions` declared per resource, all host communication via postMessage JSON-RPC, host can restrict tool calls; hosts can render third-party apps without trusting the server author [MCP-APPS].
- VS Code runs extensions in a separate extension host process (local Node, web worker, or remote) [MED-EXT] (secondary).

Implications for cmd:
- AI-generated widgets are untrusted code: test that they run in an opaque-origin iframe (or isolated session partition) with CSP, no preload, no socket, and a host bridge that checks per-widget capabilities (the Zed and MCP Apps pattern: declared, scoped, user-grantable).
- Version the widget API surface (kit versions are already planned): check an unknown capability fails closed.
- Plugins that are not first-party need a process boundary (utilityProcess), not only a convention.

## 8. Native modules and packaging

- Squirrel.Mac auto-update requires a signed app; signing, notarization and updates are one chain. Every shipped binary (native modules, helpers, bundled CLIs) must be separately signed with Hardened Runtime; one unsigned dylib fails notarization with an opaque log. Use `notarytool` (altool removed Nov 2023). One report of notarization rejection with local `codesign` passing (electron-builder 26 on Electron 36-38) [PACK-GUIDE] [APPLE-FORUM] (secondary). Validate the exact shipped zip with `spctl` and `xcrun stapler validate`.
- Fuses must be flipped before signing [E-FUSES]. `runAsNode` off means `child_process.fork` of the Electron binary stops working; Electron says to use utility processes [E-FUSES].
- Electron Forge is the Electron-maintained tool; electron-builder has a built-in updater and is most downloaded [PACK-GUIDE] (secondary).

Implications for cmd:
- A core run as `.ts` by Electron's Node is incompatible with disabling `runAsNode` as a plain fork; check how the detached core is spawned and whether the hardened fuse set breaks it. Also check detached child signing and the update path: an auto-update replaces the app while an old core and PTY host keep running from the old bundle path.
- Check the CI release verifies the notarized zip, native helpers (procinfo, node-pty) are signed and arch-correct.
- Prefer the platform for secrets (safeStorage/Keychain); check settings.json holds none.

## 9. Testing and quality at scale

- Playwright's Electron support is still labelled experimental (Electron 21+, `_electron.launch`) [PW-ELEC].
- Architecture fitness: VS Code enforces layers with a custom ESLint rule (`code-import-patterns`) and per-environment folders (`common`, `browser`, `node`, `electron-browser`, `electron-utility`, `electron-main`) with explicit allowed import directions [VSC-ORG] [MED-ARCH] (secondary). Tools: eslint-plugin-boundaries (declared element types and allowed edges) and dependency-cruiser (resolved module graph, covers ESM, used by Ghost) [BOUNDARIES] [DEPCRUISE]. Rollout advice: allowlist edges, warnings first, then errors, in CI and pre-commit.

Implications for cmd:
- Test whether layering (protocol <- core <- cli/desktop; renderer cannot import node or core) is enforced by a tool or only by convention.
- Add budgets: file size/line count, import-graph cycles, count of modules in the startup path.
- Keep the existing token-debt ratchet as the model: every architectural rule should be a ratchet file that can only go down.

## 10. Codebase structure

- VS Code layers: base, platform, editor, workbench, code, server; each layer imports only downward. Services are interface plus identifier decorator, constructor-injected, registered with `registerSingleton` (optionally delayed instantiation) [VSC-ORG].
- Contributions: nothing outside `workbench/contrib` may depend on it; each contribution exposes one `.contribution.ts` entry and one common API file; shared vs desktop-only vs web-only entry files decide what loads [VSC-ORG]. This is how the registry-plus-contribution pattern avoids god files and merge conflicts in append-only lists.
- Entry-file rule: unreferenced files must be imported from a contribution, so load graphs are explicit [VSC-ORG].

Implications for cmd:
- The append-only registries (Methods, Handlers, SETTINGS_SCHEMA, commands, layout) are the exact god-list pattern VS Code fixed with contributions; check whether each feature can register itself from its own folder instead of editing central maps.
- Check largest files in core.ts, store.ts, renderer store.ts; propose splitting by feature (service + registration) with a size ratchet.
- Module singletons vs DI: confirm tests can construct a Core with fakes (they do) and that no feature reaches into another's internals.

## Sources

- [E-SEC] https://www.electronjs.org/docs/latest/tutorial/security
- [E-FUSES] https://www.electronjs.org/docs/latest/tutorial/fuses
- [E-PROC] https://www.electronjs.org/docs/latest/tutorial/process-model
- [E-PERF] https://www.electronjs.org/docs/latest/tutorial/performance
- [E-SANDBOX] https://www.electronjs.org/docs/latest/tutorial/sandbox
- [E-PORTS] https://www.electronjs.org/docs/latest/tutorial/message-ports
- [VSC-AGENT] https://code.visualstudio.com/docs/agents/concepts/agent-host
- [VSC-TERM] https://code.visualstudio.com/docs/terminal/advanced
- [VSC-SANDBOX] https://code.visualstudio.com/blogs/2022/11/28/vscode-sandbox
- [VSC-ORG] https://github.com/microsoft/vscode/wiki/Source-Code-Organization
- [VSC-95183] https://github.com/microsoft/vscode/issues/95183
- [XT-FLOW] https://xtermjs.org/docs/guides/flowcontrol/
- [XT-WEBGL] https://npmjs.com/package/@xterm/addon-webgl
- [NODE-SQLITE] https://nodejs.org/api/sqlite.html
- [NOTION] https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite
- [LIN-TALK] https://linear.app/now/scaling-the-linear-sync-engine
- [LIN-SYNC] https://www.plushcap.com/content/linear/blog/linear-scaling-the-linear-sync-engine (secondary)
- [MCP-APPS] https://modelcontextprotocol.io/extensions/apps/overview
- [MCP-SEP] https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp
- [ZED-CAP] https://zed.dev/docs/extensions/capabilities
- [ZED-EXT] https://zed.dev/docs/extensions/developing-extensions
- [ZED-RFC] https://github.com/zed-industries/zed/discussions/50584
- [OBS] https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- [PW-ELEC] https://playwright.dev/docs/api/class-electron
- [PACK-GUIDE] https://forasoft.com/blog/article/the-pain-of-publishing-electron-apps-on-macos-303
- [APPLE-FORUM] https://developer.apple.com/forums/thread/808475
- [TS-SKEW] https://forum.tailscale.com/t/client-version-1-20-1-tailscaled-server-version-1-20-0/1609
- [TS-166] https://github.com/tailscale/tailscale/releases/tag/v1.66.0
- [ADV-2026] https://releasealert.dev/cve/CVE-2026-70601
- [DEVCLASS] https://devclass.com/2024/10/14/vs-code-migration-to-ecmascript-modules-massively-improves-startup-performance-but-extensions-left-behind-for-now/1624637
- [SNAPSHOT] https://palette.dev/blog/improving-performance-of-electron-apps
- [ELEC-43] https://electronjs.org/de/blog/electron-43-0
- [MED-EXT] https://www.mintlify.com/microsoft/vscode/concepts/extension-system
- [MED-ARCH] https://www.mintlify.com/microsoft/vscode/architecture/overview
- [BOUNDARIES] https://github.com/javierbrea/eslint-plugin-boundaries
- [DEPCRUISE] https://stevekinney.com/courses/enterprise-ui/architectural-linting-exercise
