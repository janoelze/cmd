# Remote access (mobile viewer)

> Status (2026-10-04): concept. Nothing built. Decisions below are proposals; the open questions at the end need an answer before Phase 1.

**Goal.** Turn on "Remote access" in cmd, scan a QR code with a phone, and from then on open one URL in any browser (phone or desktop, no app install) to use your Spaces on the go: the same terminals, agents, files, text and Magic windows as on the desktop, in a phone-sized layout, with push notifications when an agent needs you.

**Hard requirement: end-to-end encryption.** Everything between the Mac and the browser is encrypted with keys only those two hold. The relay in between, the host it runs on (Uberspace), the network and any CDN see only ciphertext, timing and sizes. A compromised relay can deny service; it can't read or type into a terminal.

**Non-goals (for now).** Multi-user sharing and collaboration, a native app, remote access when the Mac is asleep, and full remote control of browser windows (see "Mobile layout").

## What other tools do (research summary)

| Tool | Path | E2E | Pairing / auth | Takeaway |
|---|---|---|---|---|
| Claude Code Remote Control | Outbound HTTPS to Anthropic, which routes | No (TLS to vendor) | Session URL + QR; "Trusted Devices" re-verify with Face ID/passkey after 18 h | QR pairing; re-verify devices periodically; the host never opens an inbound port |
| Codex Remote (ChatGPT app) | OpenAI relay, same account | Unverified | QR in Settings → Connections | Same shape as Claude's |
| Happy (slopus/happy, MIT) | Socket.IO relay, Postgres/Redis | Yes: per-session AES-256-GCM keys wrapped with NaCl `box` | QR with the CLI's public key; the phone answers encrypted to it; accounts are keypairs | The closest model: a relay that only routes; QR carries a public key |
| sshx | Rust relay | Yes: Argon2id → AES-CTR, key in the URL **fragment** | The link is the key; `#key,writepw` adds write access | The fragment never reaches the server; read/write split built into the link |
| Vibe Kanban remote | Their cloud | Actions signed in the browser and checked by the host | Pairing code bound to one browser session | Have the host verify every action, not the relay |
| VibeTunnel | Mac serves the web UI; Tailscale/ngrok | Tunnel-dependent | Tunnel auth | SSE hit the 6-connections-per-host limit at the 7th terminal; multiplex over one socket. Snapshot of the visible screen on attach |
| VS Code Tunnels | Microsoft dev tunnels | SSH inside the tunnel | GitHub/MS account | Abused by APT groups for persistence: make "on" visible, off by default, logged |
| ttyd, tmate | Direct / relay | No | Token | ttyd auth bypass (a message without a token field was accepted); tmate leaked the read-write token through a world-writable dir |

Mobile UX patterns:
- Agent products (Remote Control, Happy, Omnara) show chat-style agent cards on the phone. cmd deliberately shows the real terminal instead (see "Mobile layout"), as VibeTunnel and sshx do, so nothing depends on parsing agent UIs.
- When a terminal is shown, add an extra key row above the keyboard: Esc, Ctrl, Tab, **⇧Tab** (Termius added it for Claude Code), arrows, ^C.
- iOS Safari silently freezes WebSockets in the background, so reconnect on `visibilitychange`/`pageshow`.
- iOS Web Push requires a Home Screen PWA on iOS 16.4+.

Sources: code.claude.com/docs/en/remote-control · github.com/slopus/happy (docs/encryption.md, docs/api.md) · github.com/ekzhang/sshx · vibekanban.com/blog/remote-access · steipete.me/posts/2025/vibetunnel-turn-any-browser-into-your-mac-terminal · code.visualstudio.com/docs/remote/tunnels · nccgroup.com (ttyd advisory) · CVE-2021-44512 (tmate) · bleepingcomputer.com (VS Code tunnel abuse) · docs.termius.com/terminal/mobile-terminal

## Threat model

**Assets:**
- Terminal contents: output often contains secrets and tokens.
- The ability to type into a pane, which equals a shell on the Mac.
- Files.
- Agent conversations.
- Which projects exist (paths and titles).

| Adversary | Can | Must not be able to | Mitigation |
|---|---|---|---|
| Relay operator / Uberspace compromise | See IPs, timing, frame sizes, route ids; drop or delay traffic | Read or forge anything; impersonate the host to a device or a device to the host | Noise handshake authenticates both static keys end to end; the relay only forwards bytes |
| Network attacker | Same as relay, minus routing | Same | TLS to the relay, plus Noise inside it |
| Someone who photographs the pairing QR | Pair within its lifetime | Pair silently | One-time PSK, 5 min TTL, single use, **plus approval on the Mac** ("Allow 'Safari on iPhone'?") |
| Stolen/unlocked phone | Use the paired device | Keep access after you notice | Device list with revoke (the Mac, `cmd remote revoke`); unused devices expire; optional Face ID gate for control (Phase 3) |
| Whoever serves the web client's JS | Ship JS that misuses the device key while the page is open | Exfiltrate the device key | Client on a **different origin** from the relay; non-extractable WebCrypto keys; strict CSP; reproducible builds whose hash the Mac checks (see "Web client") |
| Content shown in the client (terminal output, file contents, markdown, agent text, Magic widgets) | Attempt XSS in the client | Run script in the client origin | xterm renders text, React escapes; markdown through DOMPurify; Magic widgets only in a sandboxed iframe without `allow-same-origin`; CSP `script-src 'self'` |
| A paired "view" device | Read | Type, resize, write files, change settings, read secrets | Scopes enforced **in the core** by a typed per-method policy; default deny |
| Anyone who learns a route id | Open connections to the host and send handshake garbage | Get past the handshake | Unknown device keys are dropped after message 1; per-route rate limits at the relay, per-route failure limits in the core |
| Local malware (same user) | Everything (it already owns the account) | — | Out of scope, as for the Unix socket today |

**Residual risks to state in the UI:**
- "Control" access is a shell on your Mac.
- The web client's code comes from a server, so its integrity is only as good as that server and the hash check.
- The relay learns when you are active.

## Architecture

```
 Phone / any browser                     Relay (Uberspace)                 Mac
 ┌──────────────────────────┐           ┌──────────────────┐            ┌───────────────────────────────┐
 │ web client (PWA)         │  wss://   │ dumb forwarder   │   wss://   │ core                          │
 │  served from CLIENT      │──────────▶│ route → host     │◀───────────│  remote/ (RemoteService)      │
 │  origin (not the relay)  │  opaque   │ channel mux      │  outbound  │   ├ relay link (1 socket)     │
 │  device key (IndexedDB,  │  frames   │ no state beyond  │  only      │   ├ Noise sessions per device │
 │  non-extractable)        │           │ route registry   │            │   ├ policy (scopes)           │
 │  Noise ⇄ JSON-RPC        │           │ rate limits      │            │   └ Connection → handlers     │
 └──────────────────────────┘           └──────────────────┘            │  Unix socket (unchanged)      │
          ▲  Web Push (RFC 8291, encrypted to the device)               │  push sender (VAPID)          │
          └─────────────── Apple / Google push service ◀────────────────┘───────────────────────────────┘
```

**The gateway lives in the core** (`packages/core/src/remote/`), not in Electron or in a sidecar:
- Remote access then works while the app is closed, because the core already outlives it.
- The policy wraps handlers in-process. A sidecar would talk to the Unix socket with full rights, so it would have to re-implement and re-check the policy at a second trust boundary.
- Remote connections never touch the Unix socket.

**The Mac only connects out.** The core opens one WebSocket to the relay (Node ≥ 22 has a global `WebSocket` client, so no dependency) and multiplexes every device over it. There is no inbound port, no tunnel and no Tailscale requirement.

## Cryptographic protocol

Use **Noise**, not a home-made handshake. It is specified, has test vectors, and gives mutual authentication plus forward secrecy in one round trip.

- **Suite:** `Noise_IK_25519_AESGCM_SHA256` for sessions, `Noise_IKpsk2_25519_AESGCM_SHA256` for pairing.
- **Primitives:** X25519, AES-256-GCM, SHA-256 and HKDF. All of them exist in WebCrypto on both sides (`globalThis.crypto.subtle` in Node and browsers), so there is no crypto dependency.
- **Non-extractable keys:** WebCrypto lets the browser keep the device's static key as a **non-extractable** `CryptoKey`. `deriveBits` works on it, but script can never read the bytes.
- **Fallback:** if a target browser lacks WebCrypto X25519, use `@noble/curves` + `@noble/ciphers` (audited, no dependencies). This costs non-extractability.
- To verify before committing: X25519 in WebCrypto on current iOS Safari, Chrome and Firefox.

**Keys:**
- **Host static key** (X25519). It is generated when remote access is first enabled and stored in the login Keychain via `security add-generic-password`. The fallback is `$CMD_HOME/remote/host.key` with mode 0600, like `secrets.json`.
- Dev and release are separate instances with separate keys and device lists.
- **Device static key** (X25519). It is generated in the browser at pairing time, stored non-extractable in IndexedDB, and never leaves the device.
- **Pairing PSK.** 32 random bytes, single use, 5 min TTL, held only in core memory.
- **Route id + route secret.** 128-bit and 256-bit random values. The core registers the route with the relay, which stores `sha256(secret)`. They identify a mailbox and grant nothing else.

**Pairing (Phase 1):**
1. On the Mac, Settings → Remote → "Pair a device" (or `cmd remote pair`) shows a QR code and a link:
   `https://CLIENT/pair#v1.<relay host>.<route id>.<host pubkey>.<psk>`. Everything after `#` stays in the browser, so no server logs, proxies or analytics ever see it.
2. The browser generates its device key and connects to `wss://RELAY/r/<route id>`. It sends Noise IKpsk2 message 1, which carries the device static key (encrypted) and a payload `{name: "Safari on iPhone", ua}`.
3. The core checks the PSK and TTL and marks the PSK used. It then asks the person **on the Mac**: notification + sheet "Allow 'Safari on iPhone' to *view* / *control*? Fingerprint: four words".
   - The same four words show on the phone, so a QR that a second device grabbed is caught.
4. When the person allows it, the core stores the device and finishes the handshake. The PWA stores `{relay, route id, host pubkey, device id}`, and the **normal URL is just `https://CLIENT/`**.
   - From then on no URL carries a secret, unlike sshx-style links that stay usable forever once leaked.

**Sessions:**
- Each connection runs Noise IK. The device knows the host's static key, so a relay can't impersonate the host.
- The host looks up the device key from message 1 in its paired list. An unknown key is dropped; three failures per minute per route back off.
- Every reconnect is a fresh handshake: new ephemeral keys, forward secrecy, and one round trip.
- Transport messages use Noise's 64-bit nonces, which also block replay. Rekey after 2^20 messages or 1 h.

**Framing inside the encrypted channel:**
- The same newline-free JSON-RPC 2.0 messages the Unix socket uses, one per Noise transport message (≤ 64 KiB; larger results are chunked).
- `RpcClient` and the handler types are reused unchanged.

**What the relay sees:**
- The route id, device IPs, connection times and ciphertext sizes.
- Optional (Phase 3): pad `pane.write` frames to a fixed size and add chaff while typing, as OpenSSH 9.5 does, so keystroke timing doesn't leak.
- **No compression before encryption.** The terminal mixes attacker-influenced text with secrets, which is the setting where CRIME-style length attacks work. Batching gives most of the gain.

**Revocation and expiry:**
- `remote.revoke` deletes the device and closes its live sessions immediately.
- Devices unseen for `remote.deviceExpiryDays` (default 30) expire.
- "Turn off remote access" closes the relay link and every session. Turning it back on keeps paired devices.
- Changing the host key (rotation) unpairs everyone.

**Optional hardening (Phase 3): Face ID for control.** At pairing time the device also registers a WebAuthn passkey with RP id = the client origin. The host stores its public key. At session start, a control-scope device must answer a host-issued challenge with a user-verified assertion, and **the host verifies it**. A malicious client can't skip it, because the host checks the signature. The WebAuthn PRF extension could also wrap the device key, so it is unusable without Face ID.

## Relay

A single Node process using the `ws` package that keeps no state beyond route registrations. It is self-hostable from the repo (`apps/relay`, ~300 lines) and never serves HTML.

**Endpoints:**
- `GET /h` (Upgrade): host link. The first frame is `{route, secret}`, or `{register}` → `{route, secret}`.
- `GET /r/<route>` (Upgrade): device link. The relay assigns a channel id and forwards to the host as `[u32 channel][u8 type][payload]`.
- Frame types: `open`, `data`, `close`.

**Limits:**

| What | Limit |
|---|---|
| Frame size | 64 KiB |
| Channels per route | 8 |
| Device connections per IP per minute | 30 |
| Buffered data per channel | 1 MiB; drop the channel when exceeded |
| Pings | Every 25 s |
| Idle connections | Closed after 90 s |
| Unknown routes | Rejected; the relay never reveals whether a route exists |

**Logging:** connection counts and byte totals per route only, never payloads.

**Operational checks:**
- `Origin` must be the configured client origin for device links, which is defence in depth, not auth.
- TLS comes from Uberspace's frontend.

### Hosting on the Uberspace VPS

Measured on aquila (2026-10-04):
- About 12 Node services already run under supervisord.
- `dispatch-sync` already serves WebSockets through the Uberspace frontend.
- The account has a **1.5 GB memory cap** shared by every service (one Node process already uses about 425 MB).
- The open-file limit is **1024 file descriptors** per process.

A relay that keeps no state needs roughly 50–80 MB of RAM. One file descriptor per socket allows several hundred concurrent devices, which is far above "a few users".

Traffic, measured on the live core here (2026-10-04, 3 panes, one Claude working):

| Stream | Rate |
|---|---|
| A working Claude pane's `pane.output` | 1–13 KB/s, 10–27 chunks/s |
| An idle shell | ~0 |
| Snapshot of a pane (100×70, alt screen) | ~6 KB (more for long scrollback, at most a few hundred KB) |
| **The whole unfiltered event stream** | 15–30 KB/s, dominated by `magic.data` (~225 KB per event) and every pane's output |
| Proposed remote stream: agents + Spaces + the one watched pane | ~1–13 KB/s while you look; near zero otherwise |

**What this means:**
- An hour of active watching costs at most about 50 MB.
- Ten users each watching an hour a day come to roughly 15 GB a month, at negligible CPU.
- **Bandwidth is not the constraint.** The 1.5 GB memory cap and the uptime of a shared host are.
- The core must filter. Forwarding the raw stream would be about 100 MB/h per device for no benefit.

**Deployment:**
- A `/cmd-relay` (or subdomain) http backend plus a supervisord service, following the existing node-service pattern: `HOST=0.0.0.0`, Node from `/opt/nodejs22`.
- Because the relay keeps no state, moving it later (Fly.io or a bigger VPS) only means changing `remote.relay`.
- Open the relay to other users only after rate limits and abuse handling exist. A shared host is fine for you and early testers.

## Web client

**Origin separation is the core defence for the client.** The client is served from **a different origin than the relay**: a static build on GitHub Pages or a custom domain, published by CI from a tagged release. Then a compromised Uberspace (relay) can't serve malicious JS, and a compromised static host can't read traffic without also serving JS that targets you.

On top of that:
- **Hardened page:**
  - Strict CSP: `default-src 'none'; script-src 'self'; connect-src wss://RELAY; style-src 'self'; img-src 'self' data: blob:; frame-src blob:; base-uri 'none'; form-action 'none'`.
  - Trusted Types, no inline script, no third-party anything, SRI on every asset.
- **Reproducible build:** CI publishes the asset hashes in the GitHub release.
- **Hash check:** the core fetches `CLIENT/manifest.json` daily and compares it with the hashes in the release it knows about. On a mismatch it shows "Remote client changed unexpectedly" and turns remote access off.
  - This does not stop targeted serving to one phone, but it catches a swapped deployment.
- **Pinned service worker:** the PWA's service worker caches the app shell and only updates when the version the host reports (in the handshake payload) matches. A silently pushed client therefore doesn't take effect until your Mac agrees.

**Stack:** the desktop renderer's own code (React, xterm.js, CodeMirror), built as a third entry for the web (see "Reusing the desktop renderer"), plus a PWA manifest and service worker for Home Screen install and Web Push.

**Rendering safety:**
- Everything from the Mac is untrusted input: pane titles, agent `detail`/`lastMessage`, file contents, markdown, OSC 8 links.
- Text only through React or xterm.
- Markdown through `marked` + DOMPurify with no raw HTML.
- Links open with `rel="noopener noreferrer"` after a confirmation that shows the full URL.

**Reconnects:** reconnect on `visibilitychange`, `pageshow`, `online` and focus, using backoff, plus a heartbeat timeout of 30 s. After a reconnect, re-bootstrap: snapshots are small, so no byte-sequence resume in Phase 1.

### Mobile layout: the desktop's windows, phone-sized

**Decision: the phone shows the same windows as the desktop.**
- A terminal is a real, interactive terminal; a files window is the files window; and so on.
- Its own simple layout: every window is a full-width tab (see "Shell and navigation"). It uses the same window views as the desktop, not a separate "mobile product".
- **No screen parsing and no agent-specific views.** Agent state still comes from hooks (structured JSON), as on the desktop: the sidebar's attention markers, "next needing attention" and push notifications.
- Considered and dropped: conversation views from transcripts, prompt cards that answer by sending keys, and shell command blocks. They need per-agent knowledge of TUI layouts that breaks whenever the agents change, and they would make the phone a second product to maintain.
- The one structured shortcut kept is approving permission requests from a notification through the agents' official `PermissionRequest` hook (see "Push notifications"). It uses JSON, not screens.

#### Reusing the desktop renderer

The web client is **a third entry of the desktop renderer**, not a new app:
- **Build:** `remote.html` + `remote.tsx` next to `index.html` and `settings.html`, built by a plain Vite config (`vite.remote.config.ts`) into a static bundle.
- **Shared code:** it uses the same `store.ts`, `terminals.ts`, window registry and views (`TerminalView`, `FilesView`, `TextView`, markdown, `MagicView`), themes and fonts. Fixes and features land on both at once, and the phone looks like cmd.
- **Bridge:** `bridge.ts` picks the bridge. `window.cmd` from the preload in Electron; otherwise a **web bridge** that implements the same `CmdBridge` over the Noise channel.
  - `call` (78 call sites), `onEvent` and `onStatus` map 1:1 onto `RpcClient`.
  - The Electron-only members (used in ~15 files) get web versions:

| Electron-only | Web version |
|---|---|
| `openPath`, `revealPath` | URLs: open in a new tab after a confirmation showing the URL. Paths: open the matching cmd window (files/text) |
| `confirm`, `contextMenu`, `chooseFolder`, `chooseSavePath` | In-app sheet, long-press action sheet, folder picker over `fs.list` |
| `sfSymbols` (`Symbol.tsx`) | Lucide icons (`lucide-static` is already a dependency) |
| `notify`, `setBadge`, `bounce` | Web Push / in-app banner / no-op |
| `onCommand`, `setMenuState`, `keybindings`, `recordShortcut` | A command sheet built from `shared/commands.ts` (same ids, no accelerators); hardware-keyboard shortcuts on iPad later |
| `widgetFrame` | Static `widget-frame.html` (see "Magic windows") |
| `appInfo`, `checkForUpdates`, `installUpdate`, `restartCore`, the Settings window | Not shown remotely |
| `<webview>` (`BrowserView.tsx`) | The registry maps `browser` to a card view in the web build (title, URL, open here) |
| `cmd-file://` images (markdown) | `fs.readBinary` → blob URLs |

- **Store bootstrap:** the store's subscription becomes a bridge call (`cmd.subscribe()`), so the web bridge can use `remote.bootstrap` instead of `events.subscribe` without the store knowing.

#### Shell and navigation: tabs

The phone has **its own layout, not a copy of the desktop's**: every window is a full-width tab. Nothing about the desktop's grid, strip or canvas carries over, and nothing on the phone rearranges or resizes the desktop's windows.

- **Tabs:**
  - One tab per window of the current Space, in `grid.order`, as a scrollable tab strip at the top.
  - Each tab shows the window's icon, its title and an attention dot, as in the sidebar.
  - Swipe the content sideways to go to the next or previous tab.
- **Spaces:** a switcher above the tabs (`SpaceBar.tsx`'s data) with each Space's attention marker. ⌃⌘J ("next needing attention") becomes a button that jumps to the right Space and tab.
- **Every window is full width with the same frame:** tab strip on top, content, and a bottom bar for that window type (keys and compose for terminals, actions for others).
  - Files, text, markdown and Magic widgets reflow to the width, so they need nothing special.
  - Terminals are the exception (next section).
- **Phone state is local:** the selected tab and scroll positions are kept per device in local UI state, never in `Space.view`.
- **Tablet and desktop browsers:** the same tabs, with the sidebar's list beside them when there is room. There is no grid, strip or canvas on the web.

#### Terminals on a phone

A terminal's program draws into a fixed grid (the desktop's, e.g. 100×70), so a terminal can't simply reflow like the other window types. At phone width that grid is about 3.9 px per column in portrait (≈6.5 px font, unreadable) and about 8.5 px in landscape (≈14 px, fine).

- **Default: scaled to width, never resized.**
  - The tab shows the pane at its real size, scaled to the full width.
  - Pinch zooms and pans; rotating to landscape makes it readable.
  - Opening, scrolling or typing never changes the PTY, so looking at the phone can't disturb the desktop.
  - View-scope devices only ever get this.
- **Opt-in: "Fit to phone"** (a toggle on the terminal's bottom bar, control scope).
  - While it is on, the core resizes the PTY to the phone's width at a readable font (about 50 columns in portrait).
  - The program redraws as on any resize, and the headless terminal reflows the scrollback.
  - It is a **temporary override held by that phone**. It ends when you switch tabs, switch it off, the phone disconnects or locks (`visibilitychange`), or you type or click in that terminal on the Mac. The pane then returns to the desktop's size.
  - It is never automatic and never sticky.
- **On the Mac, while a phone holds an override:** xterm renders at the pane's actual size inside its tile, letterboxed, with a slim bar: "Fitted to iPhone · click to take back".
- **Input:** xterm.js's own keyboard input, plus:
  - **an extra key row** above the keyboard: Esc, Ctrl and Alt (sticky), Tab, ⇧Tab, arrows (swipe the row to repeat), ^C, `|`, `~`, `/`, paste;
  - **a compose bar**: a native text field (autocorrect, dictation, paste) that sends its text to the terminal on ⏎, with an option to send without ⏎. It is plain `pane.write`, no parsing, and avoids xterm's weak spots with iOS autocorrect and IME;
  - touch scrolling through scrollback, long-press to select and copy, tap on links (with confirmation).
- **iOS details:**
  - Bars follow `visualViewport`, so they sit above the keyboard.
  - With "Fit to phone" on, the fit is recomputed when the keyboard shows or hides and on rotation.

#### Other window types

The desktop views as they are, plus touch sizing (larger hit targets, tap instead of hover, no hover-only controls):

| Type | On the phone | Scope for actions |
|---|---|---|
| terminal | scaled to width; opt-in "Fit to phone" (above) | view: watch; control: type, fit to phone |
| files | `FilesView`; long-press for the context menu | view; control: create, rename, delete |
| text | `TextView` (CodeMirror 6 handles mobile input); save with `expectMtime` | view; control: save |
| markdown | rendered view, images via `fs.readBinary` | view; control: edit |
| magic | `MagicView` with the static frame (see below) | view, refresh; control: refine |
| browser | card with title and URL, "Open here" | view |
| plugin types (future) | their view, if it runs without Electron APIs; otherwise title + icon + "open on your Mac" | per type |

### Magic windows

Magic windows travel well, because the parts that matter already live in the core or in plain HTML:
- **Data:** data sources run in the core. `magic.data` events carry each refresh (`magic/service.ts:353`), and `lastData` is kept in the window state. The phone runs nothing and shows the same live data as the desktop.
- **Widget and host page:**
  - The widget is HTML in the window state.
  - The page it runs on (theme tokens, kit, `cmd` runtime) comes from `core/src/magic/host.ts`.
  - `widgetTokens` is in `@cmd/protocol`.
  - `cmd magic --out` already renders widgets as standalone pages in an ordinary browser.
- **What the client adds:** the Electron-specific `cmd-widget://frame/` page. It ships `widget-frame.html` as a static file on the client origin:
  - It carries the same CSP as `main/index.ts`, minus media, as a `<meta>` tag (static hosts can't set headers): `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; connect-src 'none'; frame-src 'none'`.
  - It is loaded in `<iframe sandbox="allow-scripts">` without `allow-same-origin`, so the frame is an opaque origin with no access to IndexedDB or the device key.
  - It speaks the existing `postMessage` protocol (`ready`/`render`/`data`/`tokens`/`rendered`/`open-url`/`error`, `MagicView.tsx:295-329`).
  - The client accepts messages only from that frame's `contentWindow`, and `open-url` only for http(s) after confirmation, as on the desktop.
- **Host page sharing:** the host page's static parts (kit CSS, `prompt/host.js`, morphdom) move into a browser-safe shared module, so the desktop frame, `cmd magic --out` and the web client serve the same bytes.
- **Layout:** widgets lay out at phone width rather than being scaled.

Limits:
- **Media widgets** stay on the Mac in Phase 1. The desktop lets a widget load media only from origins allowed per window, through an unguessable `cmd-widget://frame/<token>`. A static host has no equivalent, and a sandboxed frame can navigate itself, so a URL parameter can't carry the allowance safely. Later option: a separate frame origin whose server issues single-use tokens.
- **Creating and refining** (`magic.run`, `magic.cancel`) spends the person's API keys and runs the exploring agent on the Mac: **control** scope. `magic.refresh` is view scope (it re-runs an already approved, read-only source). `magic.media` and `magic.setRefresh` are never.
- **Traffic:** a `magic.data` event measured ~225 KB, and refreshes run whether or not the window is visible (pausing while hidden isn't built yet, docs/12). Remote connections get `magic.data` only for Magic windows they follow (`pane.follow` generalised to `window.follow`), plus `lastData` once when the window opens.
  - Building "pause refreshes when no one is looking" in the core, counting remote followers, saves both CPU and phone data.

## Core gateway

### Scopes and the policy table

There are two scopes, chosen at pairing time and changeable on the Mac:
- **view:** watch terminals, read files, see agents and Spaces, mark things seen.
- **control:** view + type into terminals, resize them, write files, open and close windows, answer permission requests.

There is no in-between "respond" scope. In a terminal-first UI, answering an agent means typing into its terminal, and an agent's input line is effectively a shell (Claude Code runs `!command`). A scope that pretends otherwise would be false comfort.

The policy is **a typed table like `Handlers`**, so adding an RPC method doesn't compile until someone decides whether a phone may call it:

```ts
// packages/core/src/remote/policy.ts
type Access = "view" | "control" | "never";
export const REMOTE_ACCESS: { [M in Method]: Access } = {
  "pane.snapshot": "view", "pane.read": "view", "agent.list": "view", "space.list": "view",
  "agent.markSeen": "view", "pane.clearAttention": "view", "magic.refresh": "view",
  "pane.write": "control", "agent.send": "control", "fs.write": "control", "window.open": "control", "window.close": "control",
  "pane.resize": "never",        // the desktop owns sizes; phones use pane.fitOverride
  "pane.fitOverride": "control", // temporary, released on tab change, disconnect or desktop input
  "agent.decide": "control",     // answers a pending PermissionRequest hook
  "settings.set": "never", "secrets.set": "never", "secrets.status": "never",
  "hook.ingest": "never", "ui.set": "never", "events.subscribe": "never", // remote uses remote.bootstrap
  "magic.run": "control",        // spends API keys, runs the exploring agent
  "magic.media": "never", "magic.setRefresh": "never",
  "window.openTarget": "never", "space.close": "never", "space.forget": "never", "search.reindex": "never",
  "remote.pair": "never", "remote.revoke": "never", // a phone can never manage pairing
  // …every method, explicitly
};
```

Arguments are checked too, not just method names:
- **`fs.*`:**
  - The path must be inside the root of an open Space.
  - It must not hit `isDeniedPath(DEFAULT_DENY_PATHS)` (reused from `magic/policy.ts`: `~/.ssh`, keychains, browser profiles, `.env`).
  - It is resolved with `realpath`, so symlinks can't escape.
- **`agent.send` / `pane.write` / `pane.fitOverride`:** the pane must exist and belong to an open Space. Writes are capped at 64 KiB; override sizes are clamped (20–300 cols, 5–200 rows).
- **Events:** a separate allowlist covering `pane.output` for followed panes only, plus `pane.updated`, `agent.*`, `space.*`, `window.*` (with the state of hidden types stripped), `notification` and `fs.changed` for watched paths. `magic.data` only for followed Magic windows. **Never** `secrets.updated` or `settings.updated`.

The policy has to be fail-closed, so it gets heavy tests: every method × scope, path traversal, symlinks, and denied paths.

### Refactors in the core

1. **Connection abstraction.**
   - Today `#serve`, `#subscribers` and `#connWatches` are keyed by `net.Socket` (`core.ts:83-87`, `351-417`).
   - Introduce `interface Connection { send(line): void; onClose(fn): void; access: Access | "local" }`.
   - `#serve` becomes a function of a `Connection`, so a Unix socket and a Noise session are two implementations.
   - `#broadcast` asks each connection's filter instead of the `types` set.
   - `call()` checks `REMOTE_ACCESS[method]` against `conn.access` before the handler runs. Local connections skip it, unchanged.
2. **Output follow and coalescing.**
   - New `window.follow { ids }` (terminals and Magic windows), per connection, so remote connections only get output for followed panes.
   - A remote connection's writer merges `pane.output` per pane over 30 ms and caps its buffer at 1 MiB. On overflow it drops the queue and sends `pane.resync`, and the client re-fetches the snapshot.
   - The local socket keeps today's raw behaviour.
3. **`remote.bootstrap`** replaces `events.subscribe` for remote connections. It returns a projection of the same data:
   - Spaces, panes, agents and windows of known types.
   - Theme colours only.
   - No settings, no `ui` state, no secrets status.
4. **Fit overrides** (`panes.ts:428`; today the last `pane.resize` wins):
   - `PaneManager` remembers the desktop's size (the last local `pane.resize`) separately from at most **one override** per pane.
   - `pane.fitOverride {paneId, cols, rows}` sets the override for the calling connection. `pane.fitOverride {paneId, release: true}` clears it.
   - The override is also cleared when that connection closes, or on local input: `pane.write` from a local connection, or a new `pane.reclaim` sent on click. The pane then goes back to the desktop size.
   - `Pane.sizedBy` names the device holding an override.
   - The desktop renderer (`terminals.ts:126`) keeps sending its fit as before. When `pane.updated` reports an override, it renders xterm at the pane's actual `cols`/`rows`, letterboxed, until the override ends.
5. **Presence.**
   - `remote.updated` events say who is connected, with which scope, since when, and from which IP (as the relay reports it, informational only).
   - The title bar shows a phone indicator whenever a device is connected; it is the visible "on" signal.
   - Every session start and end, pairing, revoke, denied call and failed handshake is written to the log scope `remote` and kept in `remote_log` (SQLite) for 30 days.
6. **Sleep.** With `remote.keepAwake` on, the core runs `caffeinate -i -w <core pid>` while remote access is enabled. This stops idle sleep, not lid-close sleep, and the UI says so.

### Push notifications

- **Subscription:** the PWA subscribes via `PushManager` and sends the subscription (endpoint, `p256dh`, `auth`) to the core over the encrypted channel. The core stores it per device.
- **Sending:** the core sends Web Push itself, with VAPID keys kept next to the host key. Payloads are encrypted to the device per RFC 8291, so Apple and Google see only that a push happened.
  - There is no push server of our own, and no relay involvement.
  - Use the `web-push` package or ~150 lines over `node:crypto`.
- **Sources:**
  - `NotificationCenter`'s `agent-input` and `agent-done`, filtered by the existing `notifications.needsInput` and `notifications.done` settings.
  - A new **"Mac is idle or locked" rule**: push only when the desktop app isn't focused or hasn't seen input for N minutes. Today the UI decides focus (`App.tsx:224-232`), so main reports focus to the core with a new `ui.presence` call.
- **Lock screen:** `remote.pushDetails` (default off) decides whether the agent's question appears there or just "Claude needs input in <Space>".
- **iOS:** push only works after "Add to Home Screen". The client detects this and explains it.

**Approving from the notification (Phase 2, optional).** Both agents have an official, JSON-based way to answer permission requests, so this needs no screen reading:
- **Claude Code:** a `PermissionRequest` hook gets `tool_name`, `tool_input` and `permission_mode`, and can return `hookSpecificOutput.decision.behavior` = `allow` / `deny`. The dialog appears only if the hook returns no decision. `ExitPlanMode` goes through the same hook. `AskUserQuestion` can't be answered this way; it stays in the terminal.
- **Codex:** the same `PermissionRequest` event and decision shape (`~/.codex/hooks.json`). Hooks are synchronous with a 600 s default timeout; with no decision the TUI prompt appears.
- **How it works in cmd:**
  - `cmd hook` stays non-blocking by default.
  - Only when remote access is on **and** the Mac is idle or locked (the presence rule) does it wait, for at most `remote.approvalWaitSeconds` (default 60), for a decision.
  - The push carries Allow / Deny actions plus the command or file. The phone's answer goes through the encrypted channel as `agent.decide {requestId, allow}` (control scope; hold-to-confirm in the client).
  - With no answer in time, the hook returns nothing and the normal prompt shows in the terminal, where the phone (or the Mac) can answer it by typing.
  - So a slow phone never blocks you at the Mac.
- **To verify before building:** how each agent behaves when the hook times out, and that a later TUI answer still works.
- Sources: code.claude.com/docs/en/hooks-guide · learn.chatgpt.com/docs/hooks.

## Integration sites

| Where | Change |
|---|---|
| `packages/protocol/src/rpc.ts` | New methods: `remote.status`, `remote.enable`, `remote.disable`, `remote.pair` (→ `{url, expiresAt}`), `remote.approve`, `remote.devices`, `remote.revoke`, `remote.setScope`, `remote.bootstrap`, `window.follow` (terminals and Magic windows), `pane.fitOverride`, `pane.reclaim`, `fs.readBinary`, `ui.presence`, `push.subscribe`, `agent.decide`. Events: `remote.updated`, `remote.pairRequest`, `pane.resync` |
| `packages/protocol/src/model.ts` | `RemoteDevice {id, name, scope, pairedAt, lastSeenAt, expiresAt, connected}`, `RemoteStatus`; `Pane.sizedBy` (which device holds the size, for the desktop's letterbox bar) |
| `packages/protocol/src/settings.ts` | `remote.enabled` (false), `remote.relay` (URL), `remote.client` (URL), `remote.deviceExpiryDays` (30), `remote.keepAwake` (false), `remote.push` (true), `remote.pushDetails` (false), `remote.approvalWaitSeconds` (60) |
| `packages/protocol/src/client.ts` | Unchanged; reused by the web client over the Noise channel |
| new `packages/remote-crypto` | Noise IK/IKpsk2 over WebCrypto, framing, fingerprint words. Shared by core and web client, browser-safe (no `node:` imports). Tested against the cacophony/snow Noise test vectors |
| `packages/core/src/core.ts` | Connection abstraction (`#serve`, `#subscribers`, `#connWatches`, `#broadcast`); policy check in `call`; handlers for the new methods; constructs `RemoteService`; `close()` shuts it down |
| new `packages/core/src/remote/` | `service.ts` (lifecycle, relay link, reconnect with backoff, settings binding via `SettingsService.bind(["remote.*"])`); `session.ts` (Noise per device, the `Connection` implementation, coalescing writer); `policy.ts` (`REMOTE_ACCESS`, argument checks, event filter); `devices.ts` (store); `keys.ts` (Keychain or file); `push.ts`; `audit.ts` |
| `packages/core/src/store.ts` | Tables `remote_devices` and `remote_log` |
| `packages/core/src/panes.ts` | Desktop size + one temporary override per pane (`fitOverride`, `reclaim`, release on close or local input). Output coalescing stays per connection, not here |
| `packages/cli/src/main.ts` (`hook`), `packages/core/src/agents/` | Phase 2: the optional waiting `PermissionRequest` path for approvals from a notification (`agent.decide`) |
| `packages/core/src/notifications.ts` | Emit to `RemoteService` for push; idle/presence rule |
| `packages/core/src/magic/host.ts`, `magic/prompt/host.js` | Static parts of the widget host page into a browser-safe shared module; the web client ships `widget-frame.html` built from it |
| `packages/core/src/magic/service.ts` | Pause source refreshes when no client (local or remote) follows the window |
| `packages/core/src/magic/policy.ts` | Move `DEFAULT_DENY_PATHS` / `isDeniedPath` to a shared `core/src/paths-deny.ts` used by Magic and remote |
| `packages/cli/src/main.ts` | `cmd remote status \| on \| off \| pair [--scope view\|control] \| devices \| revoke <id>`. `pair` prints the QR code in the terminal |
| `apps/desktop/src/shared/commands.ts` | "Remote Access…" (opens Settings → Remote), "Pair a Device…", "Disconnect Remote Devices". Each is a menu item, palette entry and keybinding target |
| `apps/desktop/src/renderer/src/settings/layout.ts` + a custom `Remote.tsx` page (like `About.tsx`) | Enable toggle, relay and client URLs, QR + fingerprint, approval sheet, device list with scope, last seen and revoke, push settings |
| `apps/desktop/src/renderer/src/App.tsx` | Presence indicator in the title bar; pairing-approval sheet on `remote.pairRequest` (also a system notification, so it works when the app is in the background) |
| `apps/desktop/src/main/index.ts` | `ui.presence` reports (focus, idle via `powerMonitor.getSystemIdleTime`); later `window.capture` for browser screenshots |
| `apps/desktop/src/preload/index.ts` | `CmdBridge` stays the contract; add `subscribe()` so the store doesn't call `events.subscribe` directly |
| `apps/desktop/src/renderer/src/bridge.ts` + new `web-bridge.ts` | Pick the preload bridge or the web bridge (Noise channel + web versions of the Electron-only members; see the table in "Reusing the desktop renderer") |
| `apps/desktop/src/renderer/src/terminals.ts` | Desktop: render at the actual size while an override is active, `pane.reclaim` on click. Web: scale-to-width mode (no `FitAddon` → no `pane.resize`), the "Fit to phone" override, extra key row, compose bar, touch scroll, pinch zoom. `MAC_KEYMAP`/app shortcuts off in the web build |
| `apps/desktop/src/renderer/src/components/TerminalView.tsx` | Letterbox + "Fitted to iPhone · click to take back" bar while a phone holds an override |
| `apps/desktop/src/renderer/src/components/Symbol.tsx` | Lucide fallback when `sfSymbols` is missing |
| `apps/desktop/src/renderer/src/windows/builtin.tsx` | Web build: `browser` → card view; markdown images via `fs.readBinary` |
| new `apps/desktop/src/renderer/remote.html`, `src/remote/` (`MobileApp.tsx`, Space switcher, tab strip, swipe pager, per-type bottom bars, touch sheets), `vite.remote.config.ts` | The web client: a tabbed shell around the shared window views; static build with CSP, PWA manifest and service worker |
| new `apps/relay` | The relay plus a supervisord `.ini` template and deploy script |
| `pnpm-workspace`, root `package.json` | `pnpm remote` (web client dev server against a local relay), `pnpm relay` (local relay), tests included in `vitest run` |
| `.github/workflows` | Build the web client reproducibly, publish to Pages, attach `manifest.json` hashes to the release |
| `e2e/` | `remote.mjs`: start a local relay, enable remote on a throwaway `CMD_HOME`, pair a Playwright **mobile-emulated** browser, type into a terminal (the PTY keeps the desktop size), turn on Fit to phone (the PTY takes the phone's size), switch tabs (it returns), and check a denied call from a view-scope device |
| `README.md`, `DEVELOPMENT.md` | User docs (how to pair, what each scope means, the risks); internals |

## Testing

- **Crypto:** Noise test vectors, round trips between Node and the browser in Playwright, PSK reuse refused, expired PSK refused, an unknown device key dropped, nonce reuse impossible (API-level).
- **Policy:**
  - A test enumerates `Methods` at runtime and asserts each has an entry; tsc enforces the same at compile time.
  - For every scope × method, the call is allowed or denied as the table says.
  - `fs` traversal, symlink escape, denied paths and `.env` are covered.
  - The event filter never emits `secrets.updated`, `settings.updated` or unfollowed `pane.output`.
- **Relay:** limits, unknown routes, channel isolation (a device can't address another device's channel), the relay never writes payloads to logs (grep its test logs for a canary string).
- **Session:** coalescing, overflow → `pane.resync`, revocation closes the live session within one round trip.
- **Fit overrides:** only one at a time per pane; released on tab change, disconnect and local input; view scope can't set one; the desktop's own resizes still apply underneath.
- **Fuzzing:** malformed frames and handshake messages against both relay and core (fast-check).
- **Before opening the relay to others:** a short external review of the protocol and policy.

## Phases

0. **Refactors with no feature change:**
   - `Connection` abstraction.
   - `REMOTE_ACCESS` table and tests.
   - `window.follow`, coalescing writer, `remote.bootstrap`.
   - `subscribe()` on the bridge; web bridge skeleton.
   - Fit overrides in `PaneManager` and the desktop's letterbox rendering.
   - Shared deny-path module.
1. **E2E access with the desktop's windows:**
   - `packages/remote-crypto`, the relay (local and Uberspace), pairing with approval on the Mac.
   - Web client: tabbed shell with Space switcher; terminals scaled to width with extra key row, compose bar and Fit to phone; files, text, markdown, Magic (no media), browser cards.
   - Scopes view and control. Presence indicator, audit log, `cmd remote`.
2. **PWA, push and polish:**
   - PWA install and Web Push with the idle rule; optional Allow/Deny from the notification via `PermissionRequest` hooks.
   - Client hash check and pinned service worker updates.
   - Touch polish: long-press menus everywhere, iPad hardware-keyboard shortcuts, grid/strip on wide screens.
3. **Hardening and extras:** WebAuthn-gated control, keystroke padding, browser screenshots, media in Magic widgets, self-hosting docs for the relay.

## Open questions

1. **Client origin:** GitHub Pages under the repo, or a custom domain (needed for a stable PWA identity; changing the origin later loses installs and push subscriptions)? A custom domain on a separate host from the relay is preferred.
2. **Relay origin:** a subdomain on Uberspace (e.g. `relay.<domain>`) or a path under endtime-instruments.org?
3. **Fit to phone, decided:** opt-in per tab, temporary, released on tab change, disconnect or desktop input. Open: should it remember the choice per pane (re-fit when you return to that tab), or always start off?
4. **New terminals and agents from the phone:** `pane.create` / `agent.spawn` as control scope? It is no more power than typing into an existing terminal, so the proposal is yes.
5. **Pairing without the Mac in reach:** never (the current proposal), or an emergency path?
6. **Relay for others:** keep it personal, or open it to other users (abuse handling, Uberspace terms, uptime)? With self-hosting documented, the default relay can stay best-effort.
