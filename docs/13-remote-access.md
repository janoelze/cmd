# Remote access (mobile viewer)

> Status (2026-10-04): concept. Nothing built. Decisions below are proposals; the open questions at the end need an answer before Phase 1.

**Goal.** Turn on "Remote access" in cmd, scan a QR code with a phone, and from then on open one URL in any browser (phone or desktop, no app install) to see your Spaces, agents, terminals, files and text windows in a simplified view, answer agents that need input, and get push notifications.

**Hard requirement: end-to-end encryption.** Everything between the Mac and the browser is encrypted with keys only those two hold. The relay in between, the host it runs on (Uberspace), the network and any CDN see only ciphertext, timing and sizes. A compromised relay can deny service; it can't read or type into a terminal.

**Non-goals (for now).** Multi-user sharing and collaboration, a native app, remote access when the Mac is asleep, and full remote control of browser windows (see "Window types").

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
- Every agent product shows **agent cards** on the phone: needs input, the question, a reply box, a diff. The raw terminal is the fallback.
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
| A paired "view" device | Read | Type, write files, change settings, read secrets | Scopes enforced **in the core** by a typed per-method policy; default deny |
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
3. The core checks the PSK and TTL and marks the PSK used. It then asks the person **on the Mac**: notification + sheet "Allow 'Safari on iPhone' to *view* / *respond* / *control*? Fingerprint: four words".
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

**Stack:**
- `apps/remote`: Vite + React + xterm.js, mobile first and also fine on desktop.
- PWA manifest and service worker for Home Screen install and Web Push.
- No CodeMirror in Phase 1; text is shown in a `<pre>`. CodeMirror (already a dependency) comes in Phase 2 for editing.

**Rendering safety:**
- Everything from the Mac is untrusted input: pane titles, agent `detail`/`lastMessage`, file contents, markdown, OSC 8 links.
- Text only through React or xterm.
- Markdown through `marked` + DOMPurify with no raw HTML.
- Links open with `rel="noopener noreferrer"` after a confirmation that shows the full URL.

**Reconnects:** reconnect on `visibilitychange`, `pageshow`, `online` and focus, using backoff, plus a heartbeat timeout of 30 s. After a reconnect, re-bootstrap: snapshots are small, so no byte-sequence resume in Phase 1.

### Views

- **Home:** Spaces with attention markers, as in the switcher. Below them, an **agents feed** sorted by `bucketOf` (needs you → done unseen → rest), using `protocol/attention.ts`.
- **Agent card:** state, `detail` (the question), `lastMessage`, a reply box (`agent.send`), "mark seen", and "open terminal".
- **Terminal:**
  - xterm.js at the **pane's own cols×rows**. The phone never resizes the PTY; it scales to width with pinch zoom or scrolls horizontally.
  - Extra key row: Esc, Ctrl (sticky), Tab, ⇧Tab, arrows, ^C, ⏎.
  - A "Type" box sends a whole line at once, which is friendlier on a phone and leaks less timing.
- **Files / text / markdown:** browse inside Space roots, read, and (control scope, Phase 2) edit with conflict detection (`expectMtime` already exists).

### Window types

| Type | Phase 1 | Later |
|---|---|---|
| terminal | snapshot + live output, input (respond/control) | byte-sequence resume |
| files | `fs.list` within the Space root | — |
| text | read-only `<pre>` with syntax highlighting | CodeMirror editing (control) |
| markdown | rendered; images via a new scoped `fs.readBinary` instead of `cmd-file://` | — |
| browser | card with title + URL; "open on this device" | screenshot via Electron `webContents.capturePage` when the app runs (core → main request); never remote-driving the Mac's logged-in browser session |
| magic | live widgets (see "Magic windows" below); terminal-kind answers are terminals | media widgets; creating and refining from the phone |
| plugin types (future) | title + icon + "not available remotely" | a type opts in with a `remote` view, declared in its registration |

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
- **Creating and refining** (`magic.run`, `magic.cancel`) spends the person's API keys and runs the exploring agent on the Mac: **control** scope. `magic.refresh` is respond scope. `magic.media` and `magic.setRefresh` are never.
- **Traffic:** a `magic.data` event measured ~225 KB, and refreshes run whether or not the window is visible (pausing while hidden isn't built yet, docs/12). Remote connections get `magic.data` only for Magic windows they follow (`pane.follow` generalised to `window.follow`), plus `lastData` once when the window opens.
  - Building "pause refreshes when no one is looking" in the core, counting remote followers, saves both CPU and phone data.

## Core gateway

### Scopes and the policy table

There are three scopes, chosen at pairing time and changeable on the Mac:
- **view:** read state, terminals, files.
- **respond:** view + answer agents, clear attention.
- **control:** respond + type into any pane, write files, open and close windows.

The policy is **a typed table like `Handlers`**, so adding an RPC method doesn't compile until someone decides whether a phone may call it:

```ts
// packages/core/src/remote/policy.ts
type Access = "view" | "respond" | "control" | "never";
export const REMOTE_ACCESS: { [M in Method]: Access } = {
  "pane.snapshot": "view", "pane.read": "view", "agent.list": "view", "space.list": "view",
  "agent.send": "respond", "agent.markSeen": "respond", "pane.clearAttention": "respond",
  "pane.write": "control", "fs.write": "control", "window.open": "control", "window.close": "control",
  "pane.resize": "never",        // the desktop owns sizes
  "settings.set": "never", "secrets.set": "never", "secrets.status": "never",
  "hook.ingest": "never", "ui.set": "never", "events.subscribe": "never", // remote uses remote.bootstrap
  "magic.run": "control",        // spends API keys, runs the exploring agent
  "magic.refresh": "respond", "magic.media": "never", "magic.setRefresh": "never",
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
- **`agent.send` / `pane.write`:** the pane must exist and belong to an open Space. Size is capped at 64 KiB.
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
4. **Presence.**
   - `remote.updated` events say who is connected, with which scope, since when, and from which IP (as the relay reports it, informational only).
   - The title bar shows a phone indicator whenever a device is connected; it is the visible "on" signal.
   - Every session start and end, pairing, revoke, denied call and failed handshake is written to the log scope `remote` and kept in `remote_log` (SQLite) for 30 days.
5. **Sleep.** With `remote.keepAwake` on, the core runs `caffeinate -i -w <core pid>` while remote access is enabled. This stops idle sleep, not lid-close sleep, and the UI says so.

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

## Integration sites

| Where | Change |
|---|---|
| `packages/protocol/src/rpc.ts` | New methods: `remote.status`, `remote.enable`, `remote.disable`, `remote.pair` (→ `{url, expiresAt}`), `remote.approve`, `remote.devices`, `remote.revoke`, `remote.setScope`, `remote.bootstrap`, `window.follow` (terminals and Magic windows), `fs.readBinary`, `ui.presence`, `push.subscribe`. Events: `remote.updated`, `remote.pairRequest`, `pane.resync` |
| `packages/protocol/src/model.ts` | `RemoteDevice {id, name, scope, pairedAt, lastSeenAt, expiresAt, connected}`, `RemoteStatus` |
| `packages/protocol/src/settings.ts` | `remote.enabled` (false), `remote.relay` (URL), `remote.client` (URL), `remote.deviceExpiryDays` (30), `remote.keepAwake` (false), `remote.push` (true), `remote.pushDetails` (false) |
| `packages/protocol/src/client.ts` | Unchanged; reused by the web client over the Noise channel |
| new `packages/remote-crypto` | Noise IK/IKpsk2 over WebCrypto, framing, fingerprint words. Shared by core and web client, browser-safe (no `node:` imports). Tested against the cacophony/snow Noise test vectors |
| `packages/core/src/core.ts` | Connection abstraction (`#serve`, `#subscribers`, `#connWatches`, `#broadcast`); policy check in `call`; handlers for the new methods; constructs `RemoteService`; `close()` shuts it down |
| new `packages/core/src/remote/` | `service.ts` (lifecycle, relay link, reconnect with backoff, settings binding via `SettingsService.bind(["remote.*"])`); `session.ts` (Noise per device, the `Connection` implementation, coalescing writer); `policy.ts` (`REMOTE_ACCESS`, argument checks, event filter); `devices.ts` (store); `keys.ts` (Keychain or file); `push.ts`; `audit.ts` |
| `packages/core/src/store.ts` | Tables `remote_devices` and `remote_log` |
| `packages/core/src/panes.ts` | None needed for output (coalescing is per connection). `resize` stays local-only through the policy |
| `packages/core/src/notifications.ts` | Emit to `RemoteService` for push; idle/presence rule |
| `packages/core/src/magic/host.ts`, `magic/prompt/host.js` | Static parts of the widget host page into a browser-safe shared module; the web client ships `widget-frame.html` built from it |
| `packages/core/src/magic/service.ts` | Pause source refreshes when no client (local or remote) follows the window |
| `packages/core/src/magic/policy.ts` | Move `DEFAULT_DENY_PATHS` / `isDeniedPath` to a shared `core/src/paths-deny.ts` used by Magic and remote |
| `packages/core/src/windows/types.ts` | Optional `remote?: { summary(state) }` per type, so the client can show something for types without a remote view |
| `packages/cli/src/main.ts` | `cmd remote status \| on \| off \| pair [--scope view\|respond\|control] \| devices \| revoke <id>`. `pair` prints the QR code in the terminal |
| `apps/desktop/src/shared/commands.ts` | "Remote Access…" (opens Settings → Remote), "Pair a Device…", "Disconnect Remote Devices". Each is a menu item, palette entry and keybinding target |
| `apps/desktop/src/renderer/src/settings/layout.ts` + a custom `Remote.tsx` page (like `About.tsx`) | Enable toggle, relay and client URLs, QR + fingerprint, approval sheet, device list with scope, last seen and revoke, push settings |
| `apps/desktop/src/renderer/src/App.tsx` | Presence indicator in the title bar; pairing-approval sheet on `remote.pairRequest` (also a system notification, so it works when the app is in the background) |
| `apps/desktop/src/main/index.ts` | `ui.presence` reports (focus, idle via `powerMonitor.getSystemIdleTime`); later `window.capture` for browser screenshots |
| `apps/desktop/src/preload/index.ts` | Split `CmdBridge` into `CoreBridge` (`call`/`onEvent`/`onStatus`) and the Electron-only rest. Only `call` is used broadly (78 call sites); the Electron-only methods sit in ~15 files. Shared modules depend on `CoreBridge` only |
| new `apps/remote` | The web client. Reuses `@cmd/protocol` (types, `RpcClient`, `attention.ts`, `space.ts`), `@cmd/remote-crypto`, theme colour tables. Does **not** reuse `store.ts` or `terminals.ts` directly: they pull in fit/resize, the mac keymap, fonts and Magic (`store.ts:9-14`, `terminals.ts:6-14`). Extract pure helpers (`renderer/src/model.ts`: `buildRows`, `inSpace`, `spaceAttention`) into a shared module instead |
| new `apps/relay` | The relay plus a supervisord `.ini` template and deploy script |
| `pnpm-workspace`, root `package.json` | `pnpm remote` (client dev), `pnpm relay` (local relay), tests included in `vitest run` |
| `.github/workflows` | Build `apps/remote` reproducibly, publish to Pages, attach `manifest.json` hashes to the release |
| `e2e/` | `remote.mjs`: start a local relay, enable remote on a throwaway `CMD_HOME`, pair a Playwright **mobile-emulated** browser, check a snapshot, an agent reply and a denied call |
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
- **Fuzzing:** malformed frames and handshake messages against both relay and core (fast-check).
- **Before opening the relay to others:** a short external review of the protocol and policy.

## Phases

0. **Refactors with no feature change:**
   - `Connection` abstraction.
   - `REMOTE_ACCESS` table and tests.
   - `window.follow`, coalescing writer, `remote.bootstrap`.
   - `CoreBridge` split.
   - Shared deny-path module.
1. **E2E viewing:**
   - `packages/remote-crypto`, the relay (local and Uberspace), pairing with approval on the Mac.
   - Web client with Home, agents feed and agent card, terminal view (read-only + respond), files and text read-only, Magic widgets (no media).
   - Scopes view and respond. Presence indicator, audit log, `cmd remote`.
2. **Control and PWA:**
   - Control scope: terminal input with extra keys, text editing, open/close windows, creating and refining Magic windows.
   - PWA install and Web Push with the idle rule.
   - Client hash check and pinned service worker updates.
3. **Hardening and extras:** WebAuthn-gated control, keystroke padding, browser screenshots, media in Magic widgets, a remote view API for plugin window types, self-hosting docs for the relay.

## Open questions

1. **Client origin:** GitHub Pages under the repo, or a custom domain (needed for a stable PWA identity; changing the origin later loses installs and push subscriptions)? A custom domain on a separate host from the relay is preferred.
2. **Relay origin:** a subdomain on Uberspace (e.g. `relay.<domain>`) or a path under endtime-instruments.org?
3. **Respond:** should the respond scope also allow `pane.write` to panes running an agent (answering a permission prompt is a keypress, not text), or only `agent.send`?
4. **New agents from the phone:** should `agent.spawn` / `pane.create` be allowed? A phone starting a new agent in a Space is attractive, but it is control-level power.
5. **Pairing without the Mac in reach:** never (the current proposal), or an emergency path?
6. **Relay for others:** keep it personal, or open it to other users (abuse handling, Uberspace terms, uptime)? With self-hosting documented, the default relay can stay best-effort.
