# 09 Electron main, IPC and security

**Score: 5/10** · reviewed 2026-10-10 against commit ddb7832 · scope: Electron main (except core lifecycle, doc 01), its IPC surface, the preloads, the embedded browser, packaging hardening (fuses, entitlements, CSP), crash/feedback senders

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 5/10 | `index.ts` is 1046 lines with eight concerns; preload imports types from six main modules |
| Correctness & robustness | 7/10 | Handlers are small and mostly defensive; a likely ⌘R collision with the Developer › Reload role |
| Performance | 7/10 | Deferred updater, SF Symbols off-thread and cached; two `sendSync` calls per window load |
| Security | 4/10 | Browser session grants every permission, no main-frame navigation guard, `openExternal` on any scheme, no fuses, extractable webhooks |
| Testability & tests | 4/10 | 22 tests on pure helpers; none on IPC handlers, guest policy, protocols or permission handlers |
| Extensibility | 5/10 | 55 string channels with untyped payloads; the remote web bridge (docs/13) has no contract to implement |
| Code health | 6/10 | Terse, well commented, good file headers; validation is ad hoc per handler |

## What this system is

Electron main (`apps/desktop/src/main/`, 21 files, 2914 lines; `index.ts` 1046) starts or adopts the core (doc 01), opens app windows per workspace (`workspaces.ts` 289, `displays.ts` 56), utility windows (Settings, Task Manager, Workbench), builds the menu bar from `shared/commands.ts` (262 lines, `menu.ts` 251, `keybindings.ts` 87), serves four privileged schemes (`cmd-file`, `cmd-widget`, `cmd-visualizer`, `cmd-jam`; `frames.ts` 71), renders widget previews offscreen (`preview.ts` 88), and sends crash reports and feedback to Discord webhooks (`crash.ts` 318, `crash-format.ts` 50, `feedback.ts` 75, `feedback-format.ts` 44). Every app and utility window runs `sandbox: false` with `contextIsolation: true` because the preload (`preload/index.ts`, 244 lines) opens the core's Unix socket itself and exposes `window.cmd`: a generic `call(method, params)` over all 142 core `Methods` (the renderer uses 103) plus 62 Electron-side members. IPC is 55 channels in main (33 `ipcMain.on`, 22 `ipcMain.handle`) against 63 `ipcRenderer` calls in the preload (31 `send`, 22 `invoke`, 2 `sendSync`, 8 `on`), and 8 main→renderer channel names. Browser windows and the YouTube widget are `<webview>` guests (`webviewTag: true`, `BrowserView.tsx` 321, `YouTubeView.tsx` 143) in partition `persist:cmd-browser`, with a sandboxed 19-line guest preload (`guest.ts`) that reports presses through `sendToHost`. Packaging: `electron-builder.yml` (hardened runtime, `entitlements.mac.plist` with five entitlements, no fuses). Design docs: docs/03-app-shell-options.md (Electron chosen, core as daemon), docs/13-remote-access.md (the bridge as contract for the web client), DEVELOPMENT.md (crash reports, feedback, signing).

## What is good

- Magic widgets, Visualizer and Jam run in `sandbox="allow-scripts"` iframes on their own schemes with per-page CSP headers (`frames.ts:31-47`, `widgetCsp`), are kept on their page by `will-frame-navigate` (`index.ts:481-485`), and are refused permissions and capture (`index.ts:991-998`). This matches the MCP Apps pattern in 00-research.md §7.
- `preview.ts:19-35` is the model for a locked-down surface: own session, every non-`data:` request cancelled, permissions denied, `setWindowOpenHandler` deny, `will-navigate` prevented, sandboxed. Other sessions should copy it.
- App pages carry a strict CSP (`renderer/index.html:6-7`): `script-src 'self' 'wasm-unsafe-eval'`, no `unsafe-eval`, frames limited to the three cmd schemes. Utility pages are stricter still.
- Certificates (`certificates.ts`) never accept a bad certificate silently: only after "Continue Anyway", only the exact fingerprint refused, per host; a renewal or impostor asks again.
- Guests get `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `safeDialogs`, and a non-web `src` is replaced with `about:blank` (`index.ts:928-938`); pop-ups are sandboxed too (`index.ts:914`).
- `edit-native` only touches a guest whose `hostWebContents` is the sender (`index.ts:232-237`); `start-file-drag` filters to existing absolute paths (`index.ts:698-706`); `play-sound` is allow-listed (`index.ts:555-559`).
- One command list drives menu, palette and context menus; accelerators live in main so shortcuts beat the terminal, and the Windows keymap avoids plain Ctrl+letter (tested, `commands.test.ts:37-38`).
- Crash reports dedupe per signature per day, cap at 10 an hour, survive a crash mid-send (`.sending` claims) and scrub home paths.

## Issues

### AR1-09-01 · Give the browser session a permission policy and pin guests to it

- **Status:** open
- **Severity:** high
- **Effort:** S
- **Where:** `apps/desktop/src/main/index.ts:927-938`, `apps/desktop/src/main/index.ts:956-965`, `apps/desktop/src/renderer/src/components/BrowserView.tsx:242`, `apps/desktop/src/renderer/src/components/YouTubeView.tsx:107`

**Problem.** Any website opened in a browser window can get camera, microphone, geolocation, notifications, MIDI, clipboard read and the `openExternal` permission (launching any registered URL scheme handler) without a prompt from cmd. Electron's default permission handler approves everything [E-SEC item 5], and `persist:cmd-browser` has no handler; only `defaultSession` and the preview session do. macOS's TCC prompt will then name cmd, not the site. Separately, the partition is chosen by the renderer's JSX attribute; `will-attach-webview` does not enforce it, so a renderer bug that drops `partition` puts web content in the default session, where `cmd-file:` reads any media file on disk and the permission handler allows all non-widget origins.

**Evidence.** `grep -rn setPermissionRequestHandler apps/desktop/src` → 2 hits: `index.ts:996` (defaultSession) and `preview.ts:24`. The only code touching `persist:cmd-browser` in main is the cookie listener at `index.ts:958`. `will-attach-webview` (`index.ts:928-938`) sets preload, nodeIntegration, contextIsolation, sandbox, scrollBounce, safeDialogs and `src`, but not the partition. No `setPermissionCheckHandler` or `setDevicePermissionHandler` anywhere. The guest preload (`guest.ts:13-19`) sends on any `pointerdown`, including synthetic ones a page dispatches (`isTrusted` unchecked).

**Proposal.** One module, `main/web-session.ts`, owns the web content policy (moved out of `index.ts:889-965`): at ready, `session.fromPartition("persist:cmd-browser")` gets a `setPermissionRequestHandler` and `setPermissionCheckHandler` that deny by default, allow `fullscreen`, `pointerLock` and `clipboard-sanitized-write`, and for `media`, `geolocation`, `notifications` and `openExternal` ask the person once per origin through a sheet in the hosting app window (main sends `permission-request` with origin and kind, the renderer answers), remembered in `site-permissions.json` next to `trusted-certificates.json`. `will-attach-webview` rejects (`event.preventDefault()`) any guest whose `params.partition` is not `persist:cmd-browser`. `guest.ts` ignores events with `!e.isTrusted`. Prior art: Chromium's own per-origin prompts; Electron security checklist items 5 and 12 [E-SEC]; `preview.ts` in this codebase.

**Success criteria.**
- [ ] `grep -n "setPermissionRequestHandler\|setPermissionCheckHandler" apps/desktop/src/main` shows both on `persist:cmd-browser`.
- [ ] A unit test of the exported policy function (no Electron) asserts `media`, `geolocation`, `notifications`, `openExternal` are not granted without a stored decision, and `fullscreen` is.
- [ ] `will-attach-webview` calls `preventDefault()` for a guest with any other partition (unit test of the exported predicate).
- [ ] `pnpm e2e` (or a new e2e step) loads a local page calling `navigator.mediaDevices.getUserMedia` in a browser window and sees it rejected or a cmd prompt, never a silent grant.
- [ ] `guest.ts` returns early on `!e.isTrusted`.

### AR1-09-02 · Guard app windows' own navigation and pop-ups in main

- **Status:** open
- **Severity:** high
- **Effort:** S
- **Where:** `apps/desktop/src/main/index.ts:456-491`, `apps/desktop/src/main/index.ts:508-535`, `apps/desktop/src/main/index.ts:903-947`

**Problem.** The app and utility windows carry the most powerful object in the app, `window.cmd.call`, which reaches `pane.spawn`/`pane.send` (a shell). Yet main never stops their main frame from navigating elsewhere or from opening windows: `will-frame-navigate` returns early for `isMainFrame`, there is no `will-navigate` handler, and `setWindowOpenHandler` is installed only on webview guests and pop-ups. Today the renderer prevents navigation case by case (markdown links `markdown-view.tsx:130-146`, drops `drops.ts:118-160`); any missed case, such as a link or URL drag the drop router does not take, or a `<form>` that DOMPurify keeps in a rendered Markdown file, would load a remote page into a window whose preload still exposes `window.cmd` [E-SEC items 13-14].

**Evidence.** `index.ts:482`: `if (e.isMainFrame || e.url.startsWith("cmd-widget:") || isFramePage(e.url)) return;`. `grep -n "will-navigate" apps/desktop/src/main` → only `preview.ts:33`. `handleWindowOpen` is called at `index.ts:923` (pop-ups) and `index.ts:947` (only `contents.getType() === "webview"`). `markdown-view.tsx:55`: `DOMPurify.sanitize(html, { ADD_ATTR: ["target"] })` with default tags (forms allowed). The preload exposes `call` unconditionally (`preload/index.ts:85-88`) without checking `location.protocol`.

**Proposal.** In `web-contents-created`, for every `contents.getType() === "window"` that is not a pop-up: `will-navigate` prevents anything that is not the page's own URL (file:// of `out/renderer/*.html`, or `ELECTRON_RENDERER_URL` in dev) and forwards http(s) to `open-url`, exactly as subframes do now; `setWindowOpenHandler` returns `deny` and forwards http(s) to `open-url`. As a second line, the preload refuses to expose `window.cmd` unless `location.origin` is the app's (`file://` or the dev server). The longer-term fix is a custom `app://` scheme instead of `file://` [VSC-SANDBOX], which also narrows CSP `'self'`.

**Success criteria.**
- [ ] `grep -n '"will-navigate"' apps/desktop/src/main` shows a handler applied to app and utility windows.
- [ ] Every `BrowserWindow` created in main has a `setWindowOpenHandler` (grep count of `new BrowserWindow` equals handled windows, or the handler is installed in `web-contents-created` for all non-guest types).
- [ ] A unit test of the exported `allowedAppUrl(url)` predicate covers app file URL, dev URL, https, file:// elsewhere, javascript:.
- [ ] The preload exposes `cmd` only when `location.protocol` is `file:` (packaged) or matches `ELECTRON_RENDERER_URL` (dev); `pnpm e2e` still passes.

### AR1-09-03 · Allow-list what `open-path` hands to `shell.openExternal` and `shell.openPath`

- **Status:** open
- **Severity:** high
- **Effort:** M
- **Where:** `apps/desktop/src/main/index.ts:656-668`, `apps/desktop/src/renderer/src/terminals.ts:284-293`, `apps/desktop/src/renderer/src/windows/markdown-view.tsx:139-140`, `apps/desktop/src/renderer/src/actions.ts:227-232`

**Problem.** Text that a program prints or a file contains can make cmd open any URL scheme or launch any file. OSC 8 hyperlinks from terminal output are activated on ⌘-click "no confirm dialog" with `allowNonHttpProtocols: true`; any scheme that is not http(s)/file goes straight to `cmd.openPath`, and main passes anything matching `^[a-z][\w+.-]+:` to `shell.openExternal` and everything else to `shell.openPath`, which launches `.app`, `.command`, `.terminal` and `.webloc` files. The visible link text can differ from the URI (that is what OSC 8 is), so `cat`-ing a hostile file or a `curl` response is enough to plant a link that says `https://github.com` and opens `smb://`, `x-apple.systempreferences:`, a custom app's URL handler, or a downloaded `.command`. This is item 15 of Electron's checklist [E-SEC]. Markdown and PDF links follow the same path (`markdown-view.tsx:140`, `PdfView.tsx:262`).

**Evidence.** `index.ts:660-662`: `/^[a-z][\w+.-]+:/i.test(p) ? await shell.openExternal(p) … : await shell.openPath(p)`; no scheme list, no extension check, no sender check. `terminals.ts:284-292`: `allowNonHttpProtocols: true`, `else cmd.openPath(uri)`. `grep -rn "openPath(" apps/desktop/src/renderer` → 31 call sites, most with first-party paths (Finder reveals, About's log), a handful with content-derived targets.

**Proposal.** Split the channel by intent so main can apply policy: `open-external(url, { from: "content" | "user" })` and `open-file(path, { from })`. Main allows `http`, `https`, `mailto` silently; any other scheme, and any file whose type is executable or a launcher (`.app`, `.command`, `.tool`, `.terminal`, `.webloc`, `.inetloc`, `.fileloc`, `.pkg`, `.dmg`, `.scpt`, executables by mode bit) when `from: "content"`, gets a native confirm sheet naming the real target ("Open smb://host/share in Finder?"). This is VS Code's approach (`security.promptForLocalFileProtocolHandling`, link-opener confirmation). Menu-driven calls ("Open with Default App", "Show in Finder") pass `from: "user"` and skip the prompt.

**Success criteria.**
- [ ] `index.ts` (or its successor module) has no `shell.openExternal` call reachable without a scheme check; a unit test of the exported `openPolicy(target, from)` covers http, mailto, smb, x-apple.systempreferences, a `.command` file, a `.app` bundle and a plain `.txt`.
- [ ] `terminals.ts` OSC 8 activation for non-http schemes goes through `from: "content"`.
- [ ] Markdown and PDF link handlers pass `from: "content"`.
- [ ] A manual or e2e check: `printf '\e]8;;smb://example\e\\click\e]8;;\e\\\n'` in a pane, ⌘-click shows a confirm sheet.

### AR1-09-04 · Flip the Electron fuses that cmd doesn't need, and move run-as-Node to a helper

- **Status:** open
- **Severity:** high
- **Effort:** L
- **Where:** `apps/desktop/electron-builder.yml:36-41`, `apps/desktop/build/entitlements.mac.plist:5-18`, `apps/desktop/src/main/index.ts:80`, `apps/desktop/src/main/index.ts:326-340`, `packages/core/src/agents/hooks.ts:43`

**Problem.** No fuse is flipped, so the signed, notarized cmd binary is a general-purpose Node runtime for any local process: `ELECTRON_RUN_AS_NODE=1 /Applications/cmd.app/Contents/MacOS/cmd -e …`, `NODE_OPTIONS=--require`, or `--inspect` run arbitrary code under cmd's code signature and TCC identity. Terminal apps routinely get Full Disk Access, and cmd has the microphone entitlement, so this turns cmd into a TCC proxy. `allow-dyld-environment-variables` together with `disable-library-validation` on the same binary adds `DYLD_INSERT_LIBRARIES` injection. Cookies of the browser partition (Google, GitHub sign-ins) are stored unencrypted because `cookieEncryption` is off [E-FUSES]. `runAsNode` can't simply be turned off: the core, the PTY host, the SQLite service and every agent hook command run Electron as Node (00-research.md §8 predicted this). `CMD_NO_SANDBOX` disables Chromium's sandbox for all renderers, guests included, in release builds too.

**Evidence.** `grep -rni "fuse" apps/desktop scripts .github` → nothing. `ELECTRON_RUN_AS_NODE` set in `index.ts:334`, `terminals/remote.ts:339`, `sqlite/service.ts:79`, `agents/hooks.ts:43`. Entitlements: `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`, `allow-dyld-environment-variables`, `device.audio-input`, applied as both `entitlements` and `entitlementsInherit`. `index.ts:80`: `if (process.env.CMD_NO_SANDBOX) app.commandLine.appendSwitch("no-sandbox");` with no `devBuild` check.

**Proposal.** Two steps. Now: an `afterPack` hook with `@electron/fuses` flips `nodeOptions` off, `nodeCliInspect` off, `cookieEncryption` on, `grantFileProtocolExtraPrivileges` off once AR1-09-02's custom scheme lands, and `embeddedAsarIntegrityValidation` + `onlyLoadAppFromAsar` on; `CMD_NO_SANDBOX` honoured only when `devBuild`. Check the hook command line and `--no-warnings` don't depend on `NODE_OPTIONS`. Then: ship the runtime's Node as its own signed helper (`Contents/Frameworks/cmd Runtime.app`, either a copy of the Electron binary with `runAsNode` left on, or an official Node binary), signed with the permissive entitlements (JIT, library validation off for node-pty, dyld variables for shells); the main app binary drops to `allow-jit` and `audio-input` and flips `runAsNode` off. Electron's alternative, `utilityProcess` [E-PROC], doesn't fit a detached core that outlives the app, so the helper is the route.

**Success criteria.**
- [ ] `npx @electron/fuses read --app dist/mac-arm64/cmd.app` shows `NodeOptions`, `NodeCliInspectArguments` disabled and `EnableCookieEncryption` enabled; CI runs this check after packaging.
- [ ] `NODE_OPTIONS=--require=/tmp/x.js /Applications/cmd.app/Contents/MacOS/cmd` does not load `/tmp/x.js`.
- [ ] `CMD_NO_SANDBOX` is ignored when `!devBuild` (grep shows the guard).
- [ ] After step two: `codesign -d --entitlements - cmd.app` shows neither `disable-library-validation` nor `allow-dyld-environment-variables` on the main binary, and `RunAsNode` is disabled; the core, PTY host, hooks and `pnpm e2e` work from the packaged app.

### AR1-09-05 · Send crash reports and feedback through cmd's own server, not baked Discord webhooks

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `apps/desktop/src/main/crash.ts:23-24`, `apps/desktop/src/main/crash.ts:73`, `apps/desktop/src/main/crash.ts:280-296`, `apps/desktop/src/main/feedback.ts:10-11`, `apps/desktop/electron.vite.config.ts:73-74`

**Problem.** Both Discord webhook URLs are string literals in `out/main/index.js` inside every release, so anyone can pull them out of the app with `strings`. A webhook token is a full credential for that webhook: post anything (with `@everyone`, the attacker sets their own `allowed_mentions`), rename it, or delete it, which silently ends crash reporting for every installed copy until a new release. The client-side caps (10/hour, per process) only bind honest clients. Main-process minidumps up to 8 MB go to the Discord channel unscrubbed: they are process memory (clipboard text, notification bodies, paths, URLs). The usage pipeline already solved this better: a per-version HMAC key, per-IP rate limits, `pause`/`stop` switches on the server (DEVELOPMENT.md, "Logs and crash reports").

**Evidence.** `electron.vite.config.ts:73-74`: `__CRASH_WEBHOOK__: JSON.stringify(process.env.CMD_CRASH_WEBHOOK ?? "")`, likewise feedback. `crash.ts:293`: the dump is attached when `st.size <= MAX_DUMP_BYTES`. `crash-format.ts:16-21`: `scrub` replaces home paths only; `payload` has no `allowed_mentions` (feedback has one, `feedback-format.ts:33`). `render-process-gone` records the guest's URL with only the query stripped (`crash.ts:100`), so the path and fragment of a browsed page are sent.

**Proposal.** Add `website/cmd/crash/ingest.php` and `feedback/ingest.php` next to the usage endpoint: signed with the same per-version key (`USAGE_KEY`, already in main), rate limited per hashed IP like usage, forwarding to Discord server-side, with the webhook held only on the server. Minidumps: keep locally, upload only when the person opts in from the crash sheet, or upload to the server (not Discord) with retention. Crash URLs: send the origin only. Rotate both webhooks once the server path ships.

**Success criteria.**
- [ ] `grep -rn "WEBHOOK" apps/desktop/electron.vite.config.ts` returns nothing; `strings` over a packaged `app.asar` finds no `discord.com/api/webhooks`.
- [ ] The server rejects unsigned or over-rate posts (PHP test or curl script in `website/`).
- [ ] `crash.ts` sends no `.dmp` without an explicit opt-in flag; `render-process-gone` context holds `new URL(url).origin` only (test in `crash-format.test.ts`).
- [ ] `payload()` includes `allowed_mentions: { parse: [] }` (test).

### AR1-09-06 · Type the IPC in one shared contract and validate at the boundary

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `apps/desktop/src/main/index.ts:546-887`, `apps/desktop/src/main/certificates.ts:59`, `apps/desktop/src/preload/index.ts:80-240`

**Problem.** The 55 channels are string literals typed twice, independently: main's handlers annotate payloads (`(_e, p: string)`) without checking them, and the preload's `api` object declares its own signatures. A renamed channel or changed payload compiles on both sides and fails silently at runtime (a `send` to a channel nobody listens on is not an error). No handler checks `event.senderFrame` [E-SEC item 17], so any frame in any app window (and, for `ipcMain.on` without a window check, the Task Manager page) can call all 55. Some channels take a path main already knows: `open-settings` writes `SETTINGS_TEMPLATE` to whatever path the renderer passes (`index.ts:736-742`). The preload imports types from six main modules (`preload/index.ts:8-16`), so the layer boundary runs the wrong way. docs/13 wants a web bridge implementing the same `CmdBridge`; with no contract module it has to mirror `typeof api`.

**Evidence.** `grep -c 'ipcMain.on(' main/index.ts` → 33, `ipcMain.handle(` → 21 (+1 in `certificates.ts`); preload: 31 `send`, 22 `invoke`, 2 `sendSync`, 8 `on`. `grep -rn senderFrame apps/desktop/src` → 0. Validated payloads by hand: `clipboard-write`, `start-file-drag`, `onboarding-seen`, `play-sound`, `allow-certificate`, `widget-frame`; unvalidated: `open-path`, `reveal-path`, `trash-path`, `choose-save-path`, `open-settings`, `set-window-size`, `notify`, `context-menu`, `set-keybinding` and the rest. Two `sendSync` per window load (`preload/index.ts:38,84`), which [E-PERF] advises against.

**Proposal.** `apps/desktop/src/shared/ipc.ts` declares `IpcMethods` (invoke: params → result), `IpcSends` (fire-and-forget) and `IpcEvents` (main → renderer), the way `packages/protocol/src/rpc.ts` declares `Methods`. Main registers through `handle<K extends keyof IpcMethods>(name, validate, fn)` where `validate` is a small guard (or valibot/zod schema) and a shared `fromAppFrame(e)` check rejects senders whose `senderFrame.url` is not an app page. The preload's `api` is generated from the same map (`invoke(name, …)` typed by key). Data types (`Appearance`, `UpdateStatus`…) move to `shared/`. `open-settings` takes no argument. The socket path and scroll-bar preference arrive as `additionalArguments` instead of `sendSync`. A remote web bridge then implements `IpcMethods` instead of reverse-engineering the preload. The MessagePort route (AR1-09-07) builds on this map.

**Success criteria.**
- [ ] `shared/ipc.ts` exists; `grep -c 'ipcMain\.\(on\|handle\)(' apps/desktop/src/main` is 0 outside the one registration helper.
- [ ] Renaming a key in `IpcMethods` fails `pnpm typecheck` in both main and preload.
- [ ] Every handler runs the sender check; a unit test of `fromAppFrame` covers app page, widget frame, guest.
- [ ] `grep -n "sendSync" apps/desktop/src/preload` returns nothing.
- [ ] `grep -n "from \"../main/" apps/desktop/src/preload` returns nothing.

### AR1-09-07 · Plan the sandboxed renderer: socket in a utility process, MessagePort to the page

- **Status:** open
- **Severity:** medium
- **Effort:** L
- **Where:** `apps/desktop/src/main/index.ts:472`, `apps/desktop/src/main/index.ts:524`, `apps/desktop/src/preload/index.ts:1-78`
- **Depends on:** AR1-09-06

**Problem.** Four window kinds run `sandbox: false` because the preload needs `node:net` for the socket and `os.homedir()`. The preload then holds a full Node context (`require` of any built-in) in every app page's isolated world; a renderer exploit that escapes context isolation (the 2026 contextBridge advisory in 00-research.md §3 is the latest such bug [ADV-2026]) lands in Node, not in Chromium's sandbox. Electron documents `sandbox: false` as the exception [E-SANDBOX]. This is a missed opportunity rather than a bug, since today the page is first-party.

**Evidence.** `index.ts:472` `sandbox: false, // preload talks to the core socket via node:net`; `index.ts:524` the same for utility windows. The preload's Node needs: `connect` (socket), `os.homedir()`, `webUtils.getPathForFile` (available sandboxed). Everything else is `ipcRenderer`.

**Proposal.** VS Code's pattern [VSC-SANDBOX] [E-PORTS]: a `utilityProcess` per app (or main itself, measured first) opens one socket per window and relays newline-delimited JSON over a `MessagePortMain`; main hands the other end to the preload with `webContents.postMessage("core-port", null, [port])`; the preload, now sandboxed, wraps the port in the same `RpcClient` (protocol already has the framing) and exposes `call/onEvent/onStatus` unchanged. `homeDir` arrives via `additionalArguments`. Measure before switching: terminal output latency and throughput through the extra hop with `yes`-style load (xterm processes 5-35 MB/s [XT-FLOW]); MessagePort transfer of strings is a copy, so batch output per frame. Keep `sandbox: false` behind a setting during rollout.

**Success criteria.**
- [ ] A spike branch measures p50/p99 latency of `pane.write` echo and output MB/s through the port vs direct socket; results recorded in docs/ with the decision.
- [ ] If adopted: `grep -n "sandbox: false" apps/desktop/src/main` returns nothing, and the preload imports no `node:` module.
- [ ] `pnpm e2e` passes with sandboxed app windows, including reconnect after `Restart Core`.

### AR1-09-08 · Split `index.ts` by concern

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `apps/desktop/src/main/index.ts:1-1046`
- **Depends on:** AR1-09-06 (the IPC moves with its contract)

**Problem.** `index.ts` holds eight concerns: boot and instance setup (1-136), core lifecycle (138-451, doc 01), app and utility windows (453-544), 55 IPC handlers (546-887), SF Symbols rendering and its disk cache (752-837), web content policy for guests and pop-ups (889-965), privileged protocol handlers (979-1007), and app lifecycle/menu/dock (969-1046). The security-relevant parts (guest policy, permission handlers, protocols, `open-path`) are scattered through the file, so a reviewer can't see the policy in one place and nothing is unit-testable without booting Electron. Every new IPC channel touches this file, which several agents edit at once (CLAUDE.md names append-only registries as the main merge conflicts).

**Evidence.** `wc -l` → 1046; the next largest main file is `crash.ts` at 318. Module-level side effects at import: `protocol.registerSchemesAsPrivileged` (96), `spawnCore()` (381), 55 `ipcMain` registrations, the SF symbol cache read (770-773).

**Proposal.** `main/boot.ts` (instance, logs, paths), `main/core-process.ts` (doc 01's part), `main/windows.ts` (createWindow, openUtility, appWindows), `main/ipc/*.ts` (one file per domain: notifications, dialogs, files, keybindings, diagnostics; each exports a `register(ipc)` against `IpcMethods`), `main/symbols.ts`, `main/web-session.ts` (AR1-09-01/02: guests, pop-ups, permissions, navigation), `main/protocols.ts` (cmd-file, cmd-widget, frames). `index.ts` becomes the composition root under 150 lines. Pure predicates (`allowedAppUrl`, `openPolicy`, permission policy, `cmd-file` path check) are exported for tests. Prior art: VS Code's `electron-main` folder of services [VSC-ORG].

**Success criteria.**
- [ ] `wc -l apps/desktop/src/main/index.ts` < 150; no file in `apps/desktop/src/main` > 350 lines.
- [ ] `grep -c "ipcMain" apps/desktop/src/main/index.ts` = 0.
- [ ] `setPermissionRequestHandler`, `will-attach-webview`, `setWindowOpenHandler`, `will-navigate` all live in `web-session.ts`.
- [ ] New tests import `web-session.ts`/`protocols.ts` predicates without Electron; `pnpm test` passes.

### AR1-09-09 · Test shortcuts against menu roles and keep every bindable command in the menu

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `apps/desktop/src/shared/commands.ts:45`, `apps/desktop/src/main/menu.ts:138`, `apps/desktop/src/main/menu.ts:9-30`, `apps/desktop/test/commands.test.ts:9-16`

**Problem.** The single command list is a good design, but three gaps let shortcuts misfire. First, menu roles carry Electron's default accelerators, which the conflict test never sees: `view.magicRefresh` is ⌘R and View › Developer › Reload is `role: "reload"` (default `CmdOrCtrl+R`), so the two compete and the View menu comes first in macOS's key-equivalent search. Second, `app.disconnectRemote` and `session.rename` are commands users can bind in `keybindings.json` (`resolveKeybindings` accepts any id in `COMMAND_BY_ID`), but neither is in the menu, so a binding does nothing, against CLAUDE.md's "every shortcut must be a real menu item". Third, the uniqueness test compares raw strings, not `norm()`, so `"Cmd+Shift+P"` and `"Shift+Cmd+P"` pass as distinct. While a shortcut is being recorded, role items (⌘Q, ⌘H, ⌘M) still fire.

**Evidence.** Loop over command ids against `menu.ts` → missing: `app.disconnectRemote`, `session.rename`. `commands.test.ts:13-14`: `new Set(all).size` on raw accelerators. `menu.ts:138`: `{ label: "Developer", submenu: [{ role: "reload" }, { role: "toggleDevTools" }] }` with no explicit accelerator.

**Proposal.** Give the Developer items explicit accelerators that don't collide (or `accelerator: undefined` plus `registerAccelerator: false`), list role accelerators (`ROLE_KEYS` in `shared/commands.ts`) and include them in the conflict test via `norm()`. Add a test that every `COMMANDS` id appears in `buildMenu`'s template (export a `menuIds()` from `menu.ts`, or build the template as data). Either add the two missing commands to the menu or mark them `menu: false` and refuse bindings for those ids.

**Success criteria.**
- [ ] `commands.test.ts` compares `norm()`ed accelerators across commands and role defaults; it fails today on ⌘R.
- [ ] A test asserts every command id is in the menu template or marked unbindable.
- [ ] ⌘R in an app window with a Magic widget selected refreshes the widget and does not reload the page (manual or e2e).

## Course corrections

1. **Close the web-content holes** (AR1-09-01, AR1-09-02, AR1-09-03): a browser-session permission policy, main-frame navigation and window-open guards on app windows, and an `openExternal`/`openPath` allow-list with provenance. All three are small, independent, and remove the realistic paths from untrusted content to the person's machine. This alone moves Security from 4 to 6.
2. **Harden the binary** (AR1-09-04): the cheap fuses now, then the runtime helper so the main binary can drop `runAsNode` and the permissive entitlements. This is the change that makes the signed app stop being a TCC proxy.
3. **Typed IPC contract, then split main** (AR1-09-06, AR1-09-08): one `IpcMethods` map with sender checks and validators, and an `index.ts` that is a composition root with the security policy in one testable module. This is what moves Structure, Testability and Extensibility, and it is the base for docs/13's web bridge and for AR1-09-07.
4. **Take the webhooks out of the app** (AR1-09-05), reusing the usage server's signing and rate limits.

## Quick wins

AR1-09-01, AR1-09-02, AR1-09-09, and the first step of AR1-09-04 (fuses `nodeOptions`, `nodeCliInspect`, `cookieEncryption`; `CMD_NO_SANDBOX` behind `devBuild`).
