# 12 Remote access, relay and web client

**Score: 4/10** · reviewed 2026-10-10 against commit ddb7832 · scope: pairing, Noise channel, relay, remote policy, the web client and their deploy

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 7/10 | Clean split (crypto package, relay, core gateway, policy table, client), but the client and relay share one host, which the design said they must not |
| Correctness & robustness | 5/10 | Sessions open after a replayable message 1; flow control drops the device at the relay instead of resyncing |
| Performance | 6/10 | Coalescing per pane is right; no end-to-end backpressure, and a reconnect re-bootstraps everything |
| Security | 3/10 | A view-only phone can read all of `$HOME` (Home is always an open workspace) and any SQLite file on disk via `ATTACH` |
| Testability & tests | 6/10 | 30 unit tests incl. cacophony vectors and a typed policy table test; the Home and ATTACH holes passed them, rekey and relay limits are untested |
| Extensibility | 6/10 | Adding a method forces a policy decision (good); events and bootstrap have no per-field projection, so each new field leaks by default |
| Code health | 8/10 | Small, well-commented files; the TODOs are honest and point at real gaps |

## What this system is

Remote access lets a phone or browser use the Mac's workspaces through a relay, end-to-end encrypted (design: `docs/13-remote-access.md`, 584 lines). Five pieces:

- **`packages/remote-crypto`** (551 lines): a hand-rolled Noise implementation over WebCrypto (`noise.ts` 413: `Noise_IK_25519_AESGCM_SHA256` for sessions, `Noise_IKpsk1_…` for pairing), framing and line chunking (`channel.ts` 74), the device side (`device.ts` 91), the pairing link codec (`pairing.ts` 29) and four fingerprint words (`words.ts` 36). Shared by the core and the web client.
- **`apps/relay`** (232 lines): a `ws` forwarder. The core holds one host link (`/h`, authenticated by a route secret); each device is a channel on it (`/r/<route>`). Frame format in `packages/protocol/src/relay.ts` (52). Deployed with `scripts/deploy-remote.sh` from `.github/workflows/remote.yml` to an Uberspace account, which also serves the web client.
- **The core gateway** (`packages/core/src/remote/`, 1,146 lines): `service.ts` (343: settings, pairing, approval, devices, audit), `link.ts` (137: relay link with backoff), `session.ts` (205: per-channel handshake, then a `Connection` the core serves like a socket client), `keys.ts` (59: host X25519 key in `$CMD_HOME/remote/host.json`), `policy.ts` (402: the `REMOTE_ACCESS` table and argument checks, plus the event allowlist).
- **The chokepoint**: `Core.#receive` calls `checkRemoteCall` for every non-local connection (`packages/core/src/core.ts:1330`); `remote.bootstrap` installs `remoteEventVisible` as that connection's event filter (`core.ts:1417-1420`).
- **The web client** (`apps/web`, 930 lines): a standalone React + xterm app (not the desktop renderer), device key non-extractable in IndexedDB, CSP in `public/.htaccess`.

Flows: **pair** (Mac makes a 5-minute single-use link `…/pair#v1.<relay>.<route>.<hostKey>.<psk>` → phone runs IKpsk1 → Mac shows name + four words, three buttons → device record saved); **session** (IK with the pinned host key → `remote.bootstrap` → events filtered per connection); **revoke** (deletes the record and closes live channels). The feature is off by default (`remote.enabled: false`, `packages/protocol/src/settings.ts:311`), with the relay and client defaulting to the author's domains.

Policy measurement: 142 methods in `REMOTE_ACCESS`: 98 `never`, 23 `view`, 21 `control`. 36 of the 44 reachable methods have an argument check; the 8 without are the 7 parameterless reads plus `jam.change`.

## What is good

- **Fail-closed by construction.** `REMOTE_ACCESS: { [M in Method]: Access }` makes tsc refuse a new method until someone picks a scope, and `remote-policy.test.ts:30` checks the table against `core.handlers`. Unknown and `__proto__` methods are denied (`Object.hasOwn`). Other allowlists in the codebase should copy this.
- **One chokepoint, verified.** Every remote request goes through `#receive` → `checkRemoteCall`; the only event paths to a remote connection are `#broadcast` with the `remoteEventVisible` filter. `data.subscribe`, `events.subscribe`, `widget.hello` and `magic.previewer` (the other per-connection channels) are all `never`. `remoteEventVisible` is an exhaustive `switch` with a `never` default, so a new event type fails to compile until classified.
- **Noise done carefully.** Passes the cacophony vectors for both patterns; ciphers serialized so nonces can't race; a nonce is consumed only by a message that decrypts; REKEY every 2^20 messages; 65,535-byte message and 16 MiB line limits; `equal` is constant-time; the relay compares secret hashes with `timingSafeEqual`.
- **Pairing UX.** PSK in the URL fragment and removed with `history.replaceState` at once (`App.tsx:24`); single use "right or wrong"; words on both screens; three equal buttons with no default trap; Esc denies; audit log as `remote.audit` events.
- **Relay hygiene.** Never logs payloads (a canary test proves it, `relay.test.ts:60`), treats unknown and offline routes alike, caps channels per route, checks Origin on device links, and the deploy pins the SSH host key.
- **Strict CSP on the client** (`default-src 'none'; script-src 'self'; frame-ancestors 'none'`), no referrer, HSTS.

## Issues

### AR1-12-01 · Stop treating the Home workspace as a root a phone may read

- **Status:** open
- **Severity:** critical
- **Effort:** S
- **Where:** `packages/core/src/remote/policy.ts:331-341`, `packages/core/src/workspaces/manager.ts:3`, `packages/core/src/workspaces/manager.ts:36-49`, `packages/core/src/magic/policy.ts:14-38`

**Problem.** `allowedPath` allows any path inside "an open workspace's root". Home is a workspace rooted at `$HOME` that "always exists" and is never closed, so for a remote device "inside your workspaces" means "anywhere in the home folder" minus a 23-entry deny-list. A **view-only** device can `fs.read`/`fs.list`/`fs.watch` cmd's own state and the usual credential files the deny-list doesn't name: `~/Library/Application Support/cmd/remote/host.json` (the host's private key **and** relay secret, which let an attacker replace the Mac on the relay and impersonate it to every paired phone), `~/.config/cmd` (settings and secrets), `~/.zsh_history`, `~/.config/gh/hosts.yml`, `~/.claude/` transcripts, browser profiles other than the five listed. This is a defect against doc 13 ("Read … secrets: must not") and the scope's own promise.

**Evidence.** `manager.ts:3`: "Home (rooted at the home folder) always exists"; `manager.ts:36-49` recreates it with `closedAt: null` on every start. `policy.ts:337`: `const roots = ctx.workspaces.list().map((s) => realpath(s.root))`, no `home` filter. The policy test itself shows it: `remote-policy.test.ts:53-58` creates `proj/` directly under `home`, never opens it as a workspace, and asserts `fs.read` of `proj/a.txt` is allowed. `DEFAULT_DENY_PATHS` has no entry for `~/Library/Application Support/cmd*`, `~/.config/cmd`, shell histories or `~/.config/gh`.

**Proposal.** Remote roots are the open workspaces **other than Home** (`!s.home`); a phone that wants a file in a project opens it through a workspace the Mac opened. Then add cmd's own directories (`cmdHome()` and `configDir()` for every instance, the transcript roots from `search/sources.ts`) and the common token files to the deny-list, and move it to the shared `core/src/paths-deny.ts` doc 13 planned (`docs/13-remote-access.md:525`) so Magic gets the same fix. Longer term, prefer an allow-list per workspace (doc 13's own "default deny" applied to paths) over a growing deny-list.

**Success criteria.**
- [ ] A test with only Home open: `fs.read`, `fs.list`, `git.status`, `sqlite.schema` on `${home}/x` are denied for both scopes.
- [ ] `remote-policy.test.ts` asserts `host.json`, `settings.json` and `secrets.json` under the instance dirs are denied even when an open workspace's root contains them.
- [ ] `DEFAULT_DENY_PATHS` lives in one shared module imported by `magic/policy.ts` and `remote/policy.ts`.
- [ ] The test at `remote-policy.test.ts:52` opens `proj` as a workspace before asserting reads are allowed.

### AR1-12-02 · Block `ATTACH` in remote SQLite queries

- **Status:** open
- **Severity:** high
- **Effort:** S
- **Where:** `packages/core/src/remote/policy.ts:142-144`, `packages/core/src/remote/policy.ts:275-277`, `packages/core/src/sqlite/worker.ts:54-58`, `packages/core/src/sqlite/worker.ts:137-147`

**Problem.** `sqlite.query` is `view` scope and its only check is that `p.path` is an allowed path. The worker keeps one read-only connection per database open across calls and runs any single statement. `ATTACH '<any path>' AS x` is a single statement, is allowed under `readOnly` + `query_only`, and persists on the cached connection, so the next `SELECT * FROM x.…` reads any SQLite file the core can open: cmd's own `cmd.sqlite` (the event log the policy marks `never` because it "holds prompts, commands, pages and output"), browser history and cookie DBs, other apps' stores. Even after AR1-12-01, one `.db` anywhere in a workspace is enough.

**Evidence.** Reproduced with Node's `node:sqlite` exactly as the worker opens files: `new DatabaseSync(a, { readOnly: true }); exec("PRAGMA query_only = ON"); prepare("ATTACH '<dir>/secret.db' AS x").all(); prepare("SELECT * FROM x.s").all()` returned `[{ v: 'TOPSECRET' }]`. The one-statement check (`worker.ts:143`) doesn't help: ATTACH and SELECT are separate calls on the same `#db`. SQLite documents that `sqlite3_stmt_readonly()` is true for ATTACH, so a read-only test won't catch it either.

**Proposal.** Quick: make `sqlite.query` `never` for remote until fixed (rows and schema are enough for the phone). Then in the worker: refuse `ATTACH`/`DETACH`/`VACUUM INTO` (after stripping comments) or, better, set an authorizer that denies `SQLITE_ATTACH` if the Node in use exposes one (`DatabaseSync#setAuthorizer`), and set the attached-database limit to 0 where available. Both local and remote callers benefit: the local SQLite window has no reason to attach either.

**Success criteria.**
- [ ] A worker test: `ATTACH` (any case, with leading comments) fails with a clear error; a following `SELECT` on the alias fails.
- [ ] A remote policy test: `sqlite.query` with an ATTACH statement from a view device is denied or errors without reading the target.
- [ ] `grep -n '"sqlite.query": "view"' packages/core/src/remote/policy.ts` returns nothing until the worker test exists.

### AR1-12-03 · Serve the web client from somewhere the relay operator can't, as the design requires

- **Status:** open
- **Severity:** high
- **Effort:** M
- **Where:** `scripts/deploy-remote.sh:14-25`, `.github/workflows/remote.yml:6-16`, `apps/web/public/.htaccess:8`, `docs/13-remote-access.md:47`, `docs/13-remote-access.md:285-290`

**Problem.** The threat model's defence against a compromised relay is that it "only forwards bytes" and that the client is served "from a different origin … Then a compromised Uberspace (relay) can't serve malicious JS". The deploy puts both on the **same Uberspace account** (`janoelze@aquila`), via one SSH key in GitHub secrets that any push to `master` under `apps/web/**` uses. Whoever holds that account or that key ships JS that sees every terminal in plaintext and uses the non-extractable device key at will; end-to-end encryption then protects against nobody the relay operator isn't. The other promised mitigations (SRI, reproducible builds, a hash the Mac checks) don't exist, and CSP `connect-src wss:` lets injected script talk to any WebSocket host.

**Evidence.** `deploy-remote.sh:24-25` rsyncs `relay.mjs` and `apps/web/dist/` to the same `$HOST`. `remote.yml` triggers on push with `paths: apps/web/**` and deploys with `secrets.UBERSPACE_SSH_KEY`. `grep -rn integrity apps/web` returns nothing. `.htaccess:8`: `connect-src wss:`.

**Proposal.** Do what doc 13 says: publish the client from a tagged release to a separate host (GitHub Pages or a second account with its own deploy key), relay keeps its own account; attach a manifest of asset hashes to the release; add SRI to the built `index.html`. Narrow `connect-src` to the configured relay origins (Vite can template it). State the residual risk in the Settings page, as doc 13 asks ("its integrity is only as good as that server"). Prior art for the hard part, verifying served JS: Meta's Code Verify extension for WhatsApp Web, and Signal's choice to not ship a web client at all; for cmd a later step is an installable PWA whose service worker pins the asset hashes after first install. Restrict the deploy key on the host (`command=` in `authorized_keys`) to the rsync targets.

**Success criteria.**
- [ ] The relay and the client deploy to different hosts/accounts with different credentials; `deploy-remote.sh` (or its successor) shows two targets.
- [ ] The built `index.html` carries `integrity=` on every script and stylesheet.
- [ ] `connect-src` names the relay origin(s), not `wss:`.
- [ ] The release workflow publishes a hash manifest for the client build.
- [ ] Settings → Remote Access states who serves the client.

### AR1-12-04 · Open a session only after the device's first transport message, not after a replayable message 1

- **Status:** open
- **Severity:** medium
- **Effort:** S
- **Where:** `packages/core/src/remote/session.ts:86-92`, `packages/core/src/remote/session.ts:107-117`, `packages/core/src/remote/service.ts:284-289`

**Problem.** In Noise IK, message 1 authenticates the initiator's static key but has no freshness: anyone who recorded one (the relay operator, by definition) can replay it. The host treats a session as open right after reading message 1: it updates the device's `lastSeenAt`, sends the reply, builds a served `Connection`, writes a `session` audit entry and shows the device as connected. A replayer can't decrypt or send anything, but can (a) keep an unused device from ever expiring by replaying every few weeks, (b) show phantom "iPhone, connected from <ip>" sessions to the user, and (c) fill a route's 8 channels so the real phone gets `busy`.

**Evidence.** `session.ts:89-91`: `this.#host.device(hs.remoteStatic!)` then `#open(...)` with no message from the device in between; `service.ts:288` saves `lastSeenAt: Date.now()` inside `device()`; `session.ts:115-116` calls `serve` and `opened` (audit "session"). Noise spec rev 34 §7.7 lists IK message 1's payload as replayable (destination property 2 at most, no replay protection).

**Proposal.** Add a `confirming` state: after writing message 2, wait (with a 10 s timer) for the first DATA frame to decrypt. Only then set `lastSeenAt`, call `serve`/`opened` and audit `session`. The web client already sends `remote.bootstrap` first, so no client change. This is the standard IK treatment (WireGuard confirms the session on the initiator's first transport packet for the same reason).

**Success criteria.**
- [ ] A test replays a recorded message 1 on a new channel: no `session` audit, `lastSeenAt` unchanged, `sessions()` empty, the channel closes within the timeout.
- [ ] The existing session tests in `packages/core/test/remote.test.ts` still pass unchanged.

### AR1-12-05 · Don't let anyone who knows the route lock every device out or burn the pairing link

- **Status:** open
- **Severity:** medium
- **Effort:** S
- **Where:** `packages/core/src/remote/service.ts:24-25`, `packages/core/src/remote/service.ts:257-260`, `packages/core/src/remote/service.ts:291-295`, `packages/core/src/remote/session.ts:95-98`

**Problem.** The core's failure limiter is global: three failed handshakes in a minute and every new channel, from every device, is dropped for the rest of the minute. The route is permanent and known to the relay, to every device ever paired and to anyone who once saw a QR or a copied link, so three junk `hello` frames a minute deny service to the owner indefinitely. Separately, `takePairing()` consumes the pairing **before** the PSK is checked, so one junk `pair` frame burns the code the owner is about to scan.

**Evidence.** `service.ts:25` `MAX_FAILURES = 3`; `service.ts:259-260` counts all failures in one array and closes any channel once it's full. `session.ts:96-98` takes the pairing, then `readMessage` checks the PSK. The relay's limit is per IP (`RELAY_LIMITS.connectsPerIpPerMinute: 30`), so the core is the only per-route guard, and it guards in the wrong direction. Doc 13's threat table promised "per-route rate limits at the relay".

**Proposal.** Key the limiter by the relay-reported IP (already passed in the `open` frame) with a short backoff per source rather than a global cut-off; keep a global ceiling well above what one attacker IP can trigger. Peek the pairing, run `readMessage`, and consume it only when the PSK decrypted. Offer "Reset route" (register a new one) in Settings for a leaked route, which also needs re-pairing; say so in the button.

**Success criteria.**
- [ ] A test: three bad handshakes from IP A, then a paired device from IP B connects.
- [ ] A test: a junk `pair` frame, then the real IKpsk1 handshake with the right PSK pairs.
- [ ] The limiter's memory is bounded (entries older than a minute pruned) and tested.

### AR1-12-06 · Bound and authenticate route registration on the relay

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `apps/relay/src/relay.ts:56-63`, `apps/relay/src/relay.ts:87-92`, `apps/relay/src/relay.ts:116-130`

**Problem.** `/h` accepts anyone: `{ register: true }` creates a route with no limit, no rate limit (the per-IP limiter runs only on `/r`), and each registration rewrites the whole state file synchronously, so registrations cost O(n) each and the file grows forever (routes never expire). Unknown routes "re-register" with whatever secret is offered, so after the relay loses state, anyone who knows a route can claim it first; the Mac then gets 4403, registers a new route, and every phone must pair again. On a shared single-process host this is the cheapest DoS in the system.

**Evidence.** `relay.ts:91` hands `/h` straight to `hostLink` before `rateLimited` (`relay.ts:95`). `relay.ts:116-121` registers unconditionally; `relay.ts:59-63` `writeFileSync` of every route per call. `relay.ts:124-127`: "An unknown route re-registers". `link.ts:128-131` re-registers on 4403. No relay test covers `/h` abuse, rate limits, `bufferedBytes` or idle timeouts (6 tests in `relay.test.ts`).

**Proposal.** Make the route a function of the secret: `route = base64url(sha256(secret))[:22]`. Then re-registering an unknown route is safe by construction (only the secret's holder can name it), the state file can go (the relay stores nothing), and squatting is impossible. Rate-limit `/h` per IP like `/r`, cap concurrent unauthenticated sockets, and close a host link that hasn't authenticated within 5 s.

**Success criteria.**
- [ ] Relay tests for: `/h` rate limit per IP, an unauthenticated host link closed after the timeout, a device terminated over `bufferedBytes`, and the route/secret binding (a wrong secret for a route can't register it).
- [ ] The relay keeps no per-route file, or writes it at most once per N seconds.
- [ ] A host whose relay restarted reconnects with its old route and its phones reconnect without pairing (test with two relay instances).

### AR1-12-07 · Give the channel real backpressure instead of letting the relay drop slow phones

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/remote/session.ts:11-14`, `packages/core/src/remote/session.ts:164-189`, `packages/core/src/remote/link.ts:49-51`, `apps/relay/src/relay.ts:147`

**Problem.** The resync path (drop pending output, send `pane.resync`) only triggers when more than 1 MiB of output arrives within one 30 ms coalescing window, which a PTY practically never produces. Past that window, frames go into a promise chain and the relay WebSocket with no check of `bufferedAmount`. The real limit is the relay: a device whose socket buffers more than 1 MiB is `terminate()`d. So a phone on a slow network that opens a terminal running `cat big.log` or a chatty build is disconnected, reconnects, re-runs the handshake and a full `remote.bootstrap`, and repeats, instead of getting a resync.

**Evidence.** `session.ts:181` checks `#pendingBytes`, which `#flush` (every 30 ms) resets to 0. `RemoteConnection.send` (`session.ts:164-171`) queues without bound. `link.ts:50` sends without reading `this.#ws.bufferedAmount`. `relay.ts:147`: `if (dev.bufferedAmount > limits.bufferedBytes) return dev.terminate()`.

**Proposal.** Track in-flight bytes per channel in the core: count bytes handed to the link, and have the device acknowledge received bytes every 64 KiB (a tiny `ack` line, or a relay-level credit frame). When unacknowledged output per channel passes a window (256 KiB), stop sending that device's `pane.output`, mark the panes dirty and send `pane.resync` once acks catch up, which the client already handles. This is SSH's channel window and VS Code's remote `PersistentProtocol` ack scheme. Also stop sending when the host link's `bufferedAmount` passes a ceiling. Local socket flow control is AR1-02-01 (see doc 02).

**Success criteria.**
- [ ] A core test with a device that reads slowly: 20 MiB of pane output yields `pane.resync`, the channel stays open, and the core's queued bytes for that channel stay under 512 KiB.
- [ ] A relay test confirms the device is not terminated in that scenario.
- [ ] `session.ts`'s top comment describes the window and the ack.

### AR1-12-08 · Project bootstrap and events per remote session the way calls are checked

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/remote/policy.ts:360-379`, `packages/core/src/core.ts:869-877`, `packages/core/src/core.ts:1417-1420`, `packages/core/src/remote/policy.ts:241-250`

**Problem.** Calls are held to "targets in an open workspace", but what a session is told is not. `remote.bootstrap` returns every pane, agent, window (with its full opaque state) and workspace, closed ones included; `pane.updated`, `agent.updated`, `window.updated` and `workspace.*` pass for any workspace. Window state includes browser history (the `TODO` at `policy.ts:373`), and agents carry `lastPrompt` and `spawn.prompt`, while the table marks `agent.summarize` `never` because events "carry prompts". Resource limits are also missing on the read side: `fs.watch` has no per-session cap, and `jam.change` (control, spends API keys) has no size checks.

**Evidence.** `core.ts:870-873` returns `this.panes.list()`, `this.agents.list()`, `this.windows.others()`, `this.workspaces.list()` unfiltered. `remoteEventVisible` returns `true` for nine event types without looking at the workspace. `packages/protocol/src/model.ts:229-230`: `lastPrompt`. 8 of 44 reachable methods have no `ARGS` entry, `jam.change` among them.

**Proposal.** One `remoteView(conn)` projection in `policy.ts` used by both bootstrap and events: drop entities outside open non-Home workspaces (AR1-12-01's rule), and strip window state through a per-type hook on the window type registry (`remoteState(state) => …`, default: none), so a new window type leaks nothing until it opts in. Decide prompts explicitly (keep `lastPrompt`, drop `spawn.prompt`, or the reverse) and write it in doc 13. Cap `fs.watch` at 32 per session and give `jam.change` text limits.

**Success criteria.**
- [ ] A test: a pane in a closed workspace is absent from `remote.bootstrap` and its `pane.updated` doesn't reach the session.
- [ ] A test: a browser window's history is absent from the remote copy of its state.
- [ ] Every reachable method with parameters has an `ARGS` entry; a test enumerates them.
- [ ] The 33rd `fs.watch` from one session is denied.

### AR1-12-09 · Keep the host key in the Keychain and give it a rotation path

- **Status:** open
- **Severity:** low
- **Effort:** M
- **Where:** `packages/core/src/remote/keys.ts:1-5`, `packages/core/src/remote/keys.ts:36-58`
- **Depends on:** AR1-12-01

**Problem.** The host's static private key and the relay secret sit together in a JSON file (0600, good) inside the instance folder. Any process of the user, a backup, a synced folder, or a remote device via AR1-12-01 can copy both, and with them impersonate the Mac to every paired phone. No command rotates the key: recovering from a leak means deleting the file by hand, which silently unpairs everything.

**Evidence.** `keys.ts:4`: "TODO: the login Keychain … first, this file as the fallback". `keys.ts:56` writes `{ key, route, secret, relay }` to one file. No `remote.*` method or CLI verb resets the key (`grep -n rotate\|reset packages/core/src/remote/*.ts` returns nothing).

**Proposal.** Store the JWK in the login Keychain (`security add-generic-password`, or Electron `safeStorage` from main if the core gets a broker), file only as the fallback the TODO describes; the same mechanism as AR1-03-08 for API keys (see doc 03), so implement once. Add `cmd remote reset` / a Settings button: new key, new route, all devices unpaired, with copy that says so.

**Success criteria.**
- [ ] On macOS `host.json` no longer contains the private key when the Keychain is available.
- [ ] `cmd remote reset` exists, is audited, and a test shows old devices refused afterwards.
- [ ] Shares its storage helper with the API-key fix from AR1-03-08.

### AR1-12-10 · Make the approval prompt name what the Mac knows, not what the device claims

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `apps/desktop/src/renderer/src/components/PairPrompt.tsx:33`, `packages/core/src/remote/session.ts:132-141`, `packages/core/src/remote/service.ts:338`, `apps/web/src/identity.ts:18-39`

**Problem.** The approval title is "Allow “{name}” to use cmd?", with `name` up to 80 characters chosen by whoever holds the link, any Unicode, quotes included: a device can call itself `iPhone” (yours). Choose Allow Control`. The words are the real check, but the title is what people read. The prompt also exists only inside the app (a `TODO` for a system notification), so a request while cmd is hidden times out. On the phone, the identity is one IndexedDB slot (`KEY = "mac"`) that any later pairing link overwrites, and Safari may evict it after seven days without use, leaving the Mac listing a device that can never return.

**Evidence.** `session.ts:140` trims and slices the name, nothing else. `service.ts:338`: "TODO: also a system notification". `identity.ts:18`: a single key; no `navigator.storage.persist()` call in `apps/web/src`.

**Proposal.** Title from what the Mac derives (the browser and OS parsed from the user agent on the Mac's side, plus the relay-reported IP), with the device-chosen name shown below in quotes and restricted to letters, digits, spaces and basic punctuation. Add the system notification. In the client, call `navigator.storage.persist()` after pairing and refuse a pairing link while paired unless the person confirms replacing the current Mac.

**Success criteria.**
- [ ] A test: a hello name with quotes, newlines or bidi controls reaches `RemotePairRequest.name` sanitized.
- [ ] A pairing request posts a system notification when no window is focused.
- [ ] The web client asks for persistent storage and confirms before replacing an existing pairing.

### AR1-12-11 · Settle the web client's architecture and test it

- **Status:** open
- **Severity:** low
- **Effort:** M
- **Where:** `apps/web/src/model.ts:1-30`, `apps/web/src/Terminal.tsx:76-124`, `apps/web/src/ui.tsx`, `docs/13-remote-access.md:315-317`, `.github/workflows/remote.yml:39-41`

**Problem.** Doc 13 says the web client is "a third entry of the desktop renderer, not a new app". It is a separate 930-line app with its own model, terminal view and UI primitives, already carrying compatibility shims (`Legacy` spaces in `model.ts`). Each desktop feature the phone should get means writing it twice. It has no unit tests; its only coverage is `e2e/web.mjs`, which CI doesn't run (the remote workflow typechecks the client and tests relay and crypto only).

**Evidence.** `apps/web/package.json` depends on neither `@cmd/ui` nor the renderer. `remote.yml:39-41` runs `vitest run apps/relay packages/remote-crypto` and `@cmd/web typecheck`. Kit reuse is covered in AR1-10-05 (see doc 10).

**Proposal.** Pick one route and write it in doc 13: either commit to the standalone client (and delete the "third entry" plan), or move the shared pieces (terminal attach/snapshot/resync logic, the model reducer) into a package both consume. The terminal attach logic is the part worth sharing first: snapshot, buffer during snapshot, live output, resync is the same protocol on both sides. Add unit tests for the model reducer and run `e2e/web.mjs` in the remote workflow before deploying.

**Success criteria.**
- [ ] Doc 13's "Reusing the desktop renderer" section matches what ships.
- [ ] `apps/web` has unit tests for the model reducer and the terminal attach sequence.
- [ ] `remote.yml` runs `e2e/web.mjs` (headless) before `deploy-remote.sh`.

### AR1-12-12 · Test the paths that only fail after hours or under attack

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `packages/remote-crypto/src/noise.ts:15-17`, `packages/remote-crypto/src/noise.ts:144-153`, `packages/remote-crypto/test/noise.test.ts`, `packages/core/test/remote.test.ts`

**Problem.** The rekey runs after 2^20 messages per direction, roughly nine hours of a busy terminal at the 30 ms coalescing rate, and no test reaches it: a mismatch would drop long sessions with "decryption failed" and nobody would see why. The two cacophony vectors check handshakes and a few transport messages only. Beyond `noise.test.ts`'s tamper test, nothing feeds malformed input to the host side (`session.ts` `#receive`, `LineOpener` with a `MORE` stream that never ends).

**Evidence.** `REKEY_EVERY` is a module constant; `grep -rn rekey packages/*/test apps/*/test` returns nothing. 30 tests across the four suites (9 in `remote.test.ts`, 6 in `relay.test.ts`, 5 policy, 10 crypto incl. 2 vectors).

**Proposal.** Make the rekey interval an option of `Transport` (default 2^20) and test a few thousand messages across several rekeys in both directions, including a failed decrypt on the boundary. Add a small property test that throws random frames at a `HostChannel` and checks it closes cleanly and `failed` is called once. Add the snow/cacophony transport-message vectors that cover more than two messages.

**Success criteria.**
- [ ] A test crosses at least three rekeys each way with the interval set to 16.
- [ ] A fuzz-style test of 1,000 random frames never throws out of `HostChannel.receive` and leaves no channel open.
- [ ] A test feeds 17 MiB of `MORE` chunks and sees the channel closed.

## Course corrections

1. **Close the read-side holes before anyone pairs a view device** (AR1-12-01, AR1-12-02). Exclude Home from remote roots, deny cmd's own dirs, block ATTACH. Both are small and change the security score most; until then "View only" grants home-folder read access, host key included.
2. **Make the relay operator untrusted for real** (AR1-12-03, AR1-12-06). Separate the client's hosting from the relay's, add SRI and a narrowed CSP, and bind routes to secrets so the relay holds no state worth stealing or squatting.
3. **Harden the session edge** (AR1-12-04, AR1-12-05). Confirm sessions on the first transport message and limit failures per source, so a recorded message or a known route can't spoof presence or lock the owner out.
4. **One projection for everything a session sees** (AR1-12-08), with window types opting into what they show remotely, so new fields stop leaking by default.
5. **Flow control end to end** (AR1-12-07), so the phone degrades to a resync instead of a reconnect loop.

## Quick wins

AR1-12-01, AR1-12-02, AR1-12-04, AR1-12-05, AR1-12-10, AR1-12-12.
