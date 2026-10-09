# 02 Protocol, RPC and clients

**Score: 5/10** · reviewed 2026-10-10 against commit ddb7832 · scope: the contract between processes (`packages/protocol`), the core's socket server and event fan-out, and every client of it (preload/renderer, CLI, web client, widgets, hooks)

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 6/10 | Clean protocol package and exhaustive `Handlers`, but one 142-entry god list, four client stacks and a CLI that links core internals |
| Correctness & robustness | 4/10 | Replies and events can cross on one connection, no backpressure on the local socket, every failure is `-32000`, malformed client params become crash reports |
| Performance | 6/10 | One stringify per event and 50 ms batching for data events; but whole-object pushes to every window, no flow control, an O(n²) line splitter |
| Security | n/a | The policy side is doc 09; the fail-closed `REMOTE_ACCESS` table is a model for the rest of the codebase |
| Testability & tests | 4/10 | No test of the wire (framing, ordering, errors, limits), 3 CLI tests, e2e never runs the CLI |
| Extensibility | 5/10 | A new method is flagged in three typed places (good); no protocol version, no capability list, skew handled by ad-hoc field probes in four files |
| Code health | 7/10 | Small, readable, commented files; `connection.ts` and `client.ts` are exactly as big as they should be |

## What this system is

The contract is `packages/protocol` (3 802 lines over 21 files): `rpc.ts` (611 lines) holds the `Methods` map, 142 methods under 28 dotted prefixes (`magic` 16, `data` 13, `pane` 12, `remote` 11, `fs` 10, `agent` 10 …), the 30-member `CoreEvent` union and the raw JSON-RPC envelope types; `model.ts` (436) the shared domain objects; `events.ts` (314) the event log's envelope and query shape; `client.ts` (72) a transport-agnostic `RpcClient` plus `lineSplitter`; `node.ts` (66) `connect()` over `node:net` and `sourceBuildId()`; `instance.ts` (135) which core a process talks to. The core serves it in `core.ts`: `Handlers` is typed `{ [M in Method]: … }` (`core.ts:146`), so tsc refuses a method without a handler; `serve()`/`#receive` (`core.ts:1295-1358`) run newline-delimited JSON-RPC 2.0 over any `Connection` (`connection.ts`, 23 lines: a Unix socket, or a remote device's Noise session), `#afterCall` (`core.ts:1375-1422`) keeps per-connection state (watches, data subscriptions, follows, the event filter), and `#broadcast` (`core.ts:1546-1554`) stringifies each event once and writes it to every subscriber whose filter accepts it. Remote connections are additionally held to `remote/policy.ts` (402 lines): an `Access` per method (142 entries, typed against `Method`), 36 argument checks, and an exhaustive event allowlist.

Clients: the Electron preload (`preload/index.ts`, 244 lines) opens the socket itself with `sandbox: false` (`main/index.ts:472`), reconnects with backoff and exposes `window.cmd` (`bridge.ts` re-wraps `call` to restore stacks); the renderer makes 214 `cmd.call(...)` calls to 103 distinct methods and reduces events in `store.ts:412-541`; Electron main opens five more connections of its own (`index.ts:165,241,284`, `crash.ts:127`, `updater.ts:123`, `workspaces.ts:270`, `preview.ts:70`). The CLI (`packages/cli/src`, 2 127 lines; `main.ts` 734) calls 68 distinct methods, is the `cmd hook` entry (`main.ts:452-477`), and runs `cmd magic`/`cmd widget` in-process by importing `@cmd/core/magic`. The web client (`apps/web/src/connection.ts`, 149; `model.ts`, 132) reuses `RpcClient` over a Noise channel and starts from `remote.bootstrap`. Widgets' `data.ts` (`widget-runtime/cmd.ts:438-473`) hand-roll a Deno Unix-socket client that may call only `widget.hello` then `data.query`. The design it follows: docs/08 (the host-agent API: spawn/send/read/wait/kill over CLI, socket and later MCP), docs/13 (the `Connection` abstraction, policy table, `remote.bootstrap`, coalescing writer: all built as designed), docs/30 (one query shape, `data.query`/`data.subscribe` replacing per-feature methods), docs/06 (plugins over "typed RPC, one schema shared by UI and plugins").

## What is good

- **Three typed registries make omissions compile errors.** `Methods` → `Handlers` (`core.ts:146`) → `REMOTE_ACCESS` (`policy.ts:20`) and the `never` check in `remoteEventVisible` (`policy.ts:398`). Adding a method without deciding what a phone may do with it does not build. Every other registry in the codebase should copy this.
- **`Connection` is the right seam.** 23 lines, and the same `serve()` runs the Unix socket, the widgets socket and a Noise session; the remote writer (`remote/session.ts:173-189`) coalesces `pane.output` per pane over 30 ms, caps pending bytes at 1 MiB and sends `pane.resync` instead of buffering: exactly the drop-and-resync policy 00-research §2 asks for.
- **One `RpcClient`** (`client.ts`) is shared by preload, CLI, web client, main and the pretend phone; `apps/web` needed no second client.
- **Snapshot-then-events for terminals**: `events.subscribe` returns the model, `pane.snapshot` the headless terminal's serialized state, and the store holds output until the snapshot lands (`store.ts:408-416, 590`). Data subscriptions are batched (50 ms, `core.ts:1472-1484`), capped (`slice(-500)`), and keyed by `seq` for paging (`events.ts:131`).
- **Skew is noticed for the app↔core pair**: `core.hello` carries `build` and `root`, main restarts a stale core (`main/index.ts:164-185`), and the packaged core runs from a per-build runtime copy so an update cannot change files under a running core.
- **Reachability is complete**: 141 of 142 methods are called from a first-party client; the one exception, `widget.hello`, is called by the Deno runtime (`widget-runtime/cmd.ts:444`). There is no dead API.
- **The CLI is a good agent interface**: `--json` nearly everywhere, `cmd events` as NDJSON, exit codes 1/2/124, errors as `cmd: …` on stderr, placement from `CMD_PANE_ID` (docs/08's "the CLI defaults to the caller's own workspace").

## Issues

### AR1-02-01 · Give the local socket flow control and a frame limit

- **Status:** open
- **Severity:** high
- **Effort:** M
- **Where:** `packages/core/src/core.ts:1280`, `packages/core/src/core.ts:1546-1554`, `packages/protocol/src/client.ts:62-72`, `apps/desktop/src/renderer/src/terminals.ts:589-593`, `packages/core/src/panes.ts:420-428`

**Problem.** Remote sessions have backpressure; local ones have none at any of the three layers 00-research §2/§6 names. The core writes every event to every local subscriber with `sock.write(line)` and ignores the return value, so a renderer that is paused (devtools, a blocked main thread, a window being torn down), a `cmd events` piped into a slow consumer, or any wedged client makes the core's socket buffer grow without bound while `yes` runs in a pane. The renderer calls `term.write(data)` without the completion callback, so xterm's own buffer absorbs the rest until its ~50 MB cap discards data. Inbound, `lineSplitter` and `#receive` accept a line of any length and `JSON.parse` it on the core's one thread; the splitter also rescans and re-copies the whole buffer per chunk (`buf.indexOf("\n")` from 0, `buf = buf.slice(i + 1)`), which is O(n²) for a long line arriving in 64 KiB chunks (a 5 MB `fs.read` answer or a large `pane.snapshot`).

**Evidence.**
- `send: (line) => void (sock.writable && sock.write(line))` (`core.ts:1280`); no `writableLength`, `drain`, `pause()` or `resume()` anywhere in `core.ts`, `terminals/*.ts`, `protocol/src` or the preload (grep returns nothing).
- The PTY host client emits `data` straight into `panes.emit("output")` → `#broadcast` (`terminals/remote.ts:201-203`, `panes.ts:428`); nothing between PTY and socket can slow the PTY.
- `remote/session.ts:14` `MAX_PENDING = 1024 * 1024` with `pane.resync`: the policy exists, for one of two transports.
- docs/13 measured 1–13 KB/s per working Claude pane and ~225 KB per `magic.data` event (`docs/13-remote-access.md:261-263`); a `cat` of a large file or a runaway build is two orders of magnitude more.

**Proposal.** Move the coalescing writer out of `remote/session.ts` into a `ConnectionWriter` used by every `Connection`: per-pane coalescing (30 ms is fine locally too), a pending-bytes cap, and on overflow drop the pane's queue and send `pane.resync`, which the renderer already handles for remote and should handle locally the same way (the snapshot path exists). Below that, honour `sock.write`'s return value: when it returns false, stop forwarding `pane.output` to that connection until `drain` (events that are not output still go through, as the remote writer does today). Add a `MAX_LINE` (16 MiB) to `lineSplitter` that closes the connection with a logged reason, and make the splitter track a scan offset instead of rescanning. In the renderer, use xterm's write callback as the ACK and send `pane.ack {paneId, bytes}` when more than a high-water mark is unacknowledged, so the core can pause the PTY (the xterm flow-control guide's watermarks, HIGH ≤ 500 K). Prior art: 00-research [XT-FLOW]; the existing `remote/session.ts` writer.

**Success criteria.**
- [ ] A test runs `yes` into a pane with a subscriber that never reads; the core's RSS stays under 100 MB over 30 s and the subscriber receives `pane.resync` (`packages/core/test/flow-control.test.ts`).
- [ ] `grep -n "sock.write(line)" packages/core/src/core.ts` returns nothing; all socket writes go through one writer that checks the return value.
- [ ] `lineSplitter` rejects a line over the limit (test), and splitting a 5 MB line fed in 64 KiB chunks takes under 50 ms (test with `performance.now()`).
- [ ] `pnpm e2e` has a scenario that pauses the renderer (CDP `Debugger.pause`) for 5 s during heavy output and shows the terminal resynced, not frozen or garbled.
- [ ] `scripts/perf/stress-core.mjs` reports no `[lag]` over 100 ms attributed to `rpc`/broadcast during the output phase.

### AR1-02-02 · Make event-versus-reply ordering a guarantee, or stop relying on it

- **Status:** open
- **Severity:** high
- **Effort:** M
- **Where:** `packages/core/src/core.ts:1297`, `packages/core/src/core.ts:1313-1343`, `packages/core/src/terminals/remote.ts:196-216`, `apps/desktop/src/renderer/src/store.ts:408-416`, `apps/desktop/src/renderer/src/store.ts:583-586`

**Problem.** The store's correctness after a reconnect rests on an ordering the core does not provide. `Served.receive` runs `void this.#receive(conn, line)`: each request is an independent async task, so replies leave in completion order, not request order, and an event emitted while a handler awaits is written before that handler's reply. For `pane.snapshot` the handler awaits the PTY host; when the host's snapshot reply and the next output line arrive in one TCP chunk, `RemoteBackend.#receive` processes both synchronously: the output is broadcast immediately, the reply resolves a promise that runs after the loop. The renderer then sees `pane.output` before the snapshot response, is still in `awaitingSnapshot`, and drops bytes that the snapshot does not contain. The window is small, but it is hit precisely during reconnects after a core restart with busy agents, which is when every pane is snapshotting.

**Evidence.**
- `store.ts:408-411`: "Events and responses share one ordered socket, so anything received before the snapshot response is already contained in the snapshot." and `store.ts:583-585`: "Answers come back in the order asked (one socket)". Neither holds for async handlers.
- `core.ts:1297` `receive: (line) => void this.#receive(conn, line)`; `#receive` awaits `this.call()` (`core.ts:1337`) before `reply()` (`core.ts:1342`).
- `terminals/remote.ts:201-203` emits `data` synchronously inside the line loop; `remote.ts:212` resolves the pending snapshot promise (a microtask) in the same loop.
- No event carries a sequence number (`rpc.ts:496-544`); `pane.output` has `{paneId, data}` only.

**Proposal.** Adopt docs/13's and 00-research §1's rule explicitly: a client starts from a snapshot and then applies ordered deltas, with a cursor to join them. Give every pane a monotonic output offset in the core (bytes emitted since the pane started): `pane.output {paneId, data, offset}` and `pane.snapshot → {data, cols, rows, offset}`. The renderer keeps output that arrives while awaiting a snapshot and, when the snapshot lands, applies only output with `offset > snapshot.offset`. This makes ordering irrelevant and also covers `pane.resync`. Separately, document in `connection.ts` that replies are unordered relative to each other and to events, and delete the two comments in `store.ts`. Do not serialize `#receive` per connection to "fix" this: one slow `search.files` would then block `pane.write`.

**Success criteria.**
- [ ] `pane.output` and `pane.snapshot` carry `offset`; a core test feeds output and a snapshot in the same tick and asserts a client applying the rule loses no bytes.
- [ ] `grep -n "order asked\|ordered socket" apps/desktop/src/renderer/src/store.ts` returns nothing.
- [ ] A reconnect e2e (restart the core while `yes | head -c 50M` runs in two panes) shows both terminals' content identical to `pane.read` afterwards.
- [ ] `connection.ts`'s header states the ordering contract in one sentence.

### AR1-02-03 · Negotiate protocol version and capabilities in `core.hello`

- **Status:** open
- **Severity:** high
- **Effort:** M
- **Where:** `packages/protocol/src/rpc.ts:79`, `packages/core/src/core.ts:71`, `packages/core/src/core.ts:592`, `apps/desktop/src/renderer/src/store.ts:555,572-576`, `apps/web/src/model.ts:19-21,43-51`, `packages/protocol/src/instance.ts:119-130`, `packages/cli/src/main.ts:158-166`

**Problem.** Skew is real today and handled by guesswork. `core.hello.version` is the constant `"0.0.1"` (`core.ts:71`), never bumped and never read. There is no protocol version and no capability list, so a client cannot ask "does this core have `remote.status`?"; it calls and treats failure as absence. But an unknown method and a runtime failure both come back as `-32000` (AR1-02-04), so "old core" and "broken core" are indistinguishable. The pairs that skew: the app and a core of another build (handled by restart, fine); a `cmd` binary from PATH (the core's own `<state dir>/bin/cmd` is first on PATH in panes, but not in other shells, SSH sessions or sandboxes) against any core (no check at all: the CLI never calls `core.hello`); the hosted web client, deployed on every master push, against Macs on any release (docs/13: "The client deploys first"); widgets' `data.ts` against the core. The renames Spaces→Workspaces already produced shims in the web client that read both shapes forever.

**Evidence.**
- Four ad-hoc probes: `store.ts:555` `if (!snap.settings) throw new Error("core is running older code…")`; `store.ts:572-576` `remote.status` wrapped in a catch "An older core has no remote access"; `apps/web/src/model.ts:19-21,43-51` the `Legacy` type mapping `spaces`/`spaceId`/`space.*`; `instance.ts:121-129` "Cores from before core.hello reported stateDir are recognised by the instance's pid file".
- `rpc.ts:79` documents the pattern itself: "(older cores omit it)".
- `main/index.ts:181` "An unresponsive or very old core: leave it, the UI shows the error."
- 00-research §1: Tailscale's "client version != server version" failure mode; §2: "verify … an explicit handshake carrying protocol version and capabilities".

**Proposal.** Make `core.hello` the negotiation: `{ protocol: number; app: string (CMD_APP_VERSION); build; root; stateDir; methods: Method[]; events: CoreEvent["type"][] }`, with `PROTOCOL` a constant in `rpc.ts` bumped on any incompatible change (a removed field, a renamed method; additions never bump). `RpcClient` gains `hello()` that stores the method set and a typed `has(method)`; `connect()` in `node.ts` and the web `Connection` call it first. Policy per client: the app restarts a core whose `protocol` differs (already does by build); the CLI prints "cmd 0.26 talking to a core of 0.24: run the cmd in `$CMD_HOME/bin`" when `protocol` differs and otherwise degrades per `has()`; the web client keeps its `Legacy` shims only behind `has("workspace.list")` and deletes them one release after. Remove `VERSION` from `core.ts`. The `REMOTE_ACCESS` table already enumerates every method, so `methods` costs nothing to produce.

**Success criteria.**
- [ ] `grep -n 'VERSION = "0.0.1"' packages/core/src/core.ts` returns nothing; `core.hello` returns `protocol`, `app`, `methods`.
- [ ] `grep -rn "older core\|older code\|Legacy" apps/desktop/src/renderer/src/store.ts apps/web/src/model.ts` returns nothing (the probes are replaced by `has()`).
- [ ] A test connects an `RpcClient` to a core whose hello lacks a method and asserts `has()` is false and `call()` fails with `-32601` before any socket write.
- [ ] `cmd ls` against a core with a different `protocol` prints the one-line explanation and exits 2 (CLI test with a fake server).
- [ ] CHANGELOG/DEVELOPMENT.md say when `PROTOCOL` is bumped.

### AR1-02-04 · Type the errors and validate params at the boundary

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/core.ts:1324`, `packages/core/src/core.ts:1344-1357`, `packages/core/src/core.ts:1179-1183`, `packages/protocol/src/client.ts:5-11`, `packages/protocol/src/rpc.ts:592-597`, `apps/desktop/src/renderer/src/bridge.ts:13-23`

**Problem.** The error channel carries one bit. Every handler failure, including "unknown method" from `call()`, becomes `{code: -32000, message}`; only `RemoteDenied` gets `-32001`. There is no `-32601` (method not found), no `-32602` (invalid params), no `data`, and no stable error kinds (`not-found`, `conflict` for `fs.write`'s mtime check, `unavailable` for "transcripts are off"). Clients branch on message text or on nothing. On the local socket params are cast `as never` and handed to handlers unchecked; the remote path checks 36 methods' arguments, the local path zero. A CLI, script or widget that sends `{paneId: 42}` triggers a `TypeError` in a handler, which `#receive` treats as a core bug and writes as a crash report that main then sends to Discord. The renderer's `bridge.ts` exists only to re-attach a stack because `contextBridge` strips everything but the message.

**Evidence.**
- `core.ts:1352-1356`: "a TypeError and the like is a bug in the core: report it" → `recordCrash(...)`, then `reply({ error: { code: -32000, … } })`.
- `core.ts:1181` `throw new Error(\`unknown method: ${method}\`)` → surfaces as `-32000`.
- `RpcError` (`client.ts:5-11`) has `code` and `message` only; `RpcResponse.error` (`rpc.ts:596`) has no `data`.
- `core.ts:1324` `const params = (req.params ?? {}) as never;` no shape check for local connections; `policy.ts:180-300` checks 36 methods for remote ones.
- `store.ts:555` and the web client's `Legacy` path both guess at errors by probing fields, because the code cannot be relied on.

**Proposal.** Define `RpcErrorCode` in `rpc.ts`: the JSON-RPC standard codes (`-32601` method not found, `-32602` invalid params, `-32603` internal) plus an application range with a `kind` in `data`: `{kind: "not-found" | "conflict" | "denied" | "unavailable" | "too-large" | "invalid", detail?}`. In the core, a small `CoreError(kind, message)` class that handlers throw for expected failures; `#receive` maps `CoreError` → its code, `RemoteDenied` → denied, unknown method → `-32601`, anything else → `-32603` with the crash report (the existing TypeError rule then means what it says). For params, do not hand-write a validator per method: generate one once from `Methods` (ts-json-schema-generator or typia at build time into `packages/protocol/src/schemas.gen.ts`, checked by a staleness test like `tokens.css`), and apply it in `#receive` for every connection, replying `-32602` with the path of the bad field. `RpcError` carries `kind`; the CLI maps `not-found` to exit 3, `denied` to 4, keeps 1 for the rest, and prints `kind` in `--json` errors. Prior art: 00-research §2 (MCP Apps' JSON-RPC dialect uses standard codes); the exhaustive-registry pattern already in this codebase.

**Success criteria.**
- [ ] `rpc.ts` exports `RpcErrorCode` and `RpcErrorKind`; `RpcError` has `kind`.
- [ ] A test sends `{"method":"nope"}`, `{"method":"pane.write","params":{"paneId":42}}` and `{"method":"pane.read","params":{"paneId":"missing"}}` over a socket and asserts `-32601`, `-32602` (with the field path) and `not-found`, and that no crash report file is written.
- [ ] `grep -rn "throw new Error(" packages/core/src/core.ts | wc -l` drops to 0 in handlers (they throw `CoreError`).
- [ ] `schemas.gen.ts` exists with a staleness test; validation adds under 50 µs per call in the stress script's report.
- [ ] `cmd read nope` exits 3 and prints `cmd: no such pane or agent: nope`.

### AR1-02-05 · Define the contract per service, keep one flat wire namespace

- **Status:** open
- **Severity:** medium
- **Effort:** L
- **Where:** `packages/protocol/src/rpc.ts:74-490`, `packages/core/src/core.ts:591-880`, `packages/core/src/remote/policy.ts:20-163`, `packages/protocol/src/rpc.ts:496-544`

**Problem.** The contract's shape is right for the wire and wrong for the editor. Dotted string method names over JSON-RPC are the convention (VS Code, MCP, LSP) and the policy table depends on them; a tRPC-style router would change the wire and add a dependency for nothing. But the definition is a single 416-line interface in one file, mirrored by a 290-line object literal in a 1 640-line `core.ts` and a 142-line table in `policy.ts`: the exact append-only god lists CLAUDE.md warns conflict most ("`Methods` in `rpc.ts`, `Handlers` in `core.ts`") and that VS Code replaced with per-feature contributions (00-research §10). Every feature touches the same three hunks. Events are a 30-member union with no map, so `events.subscribe {types}` is typed but `remoteEventVisible` needs a 40-line switch to stay exhaustive, and nothing ties an event to the service that emits it.

**Evidence.**
- `rpc.ts` 611 lines; `Methods` spans lines 74–490; 28 prefixes (`grep -oE '^  "[a-zA-Z.]+": \{' | cut -d. -f1 | sort | uniq -c`).
- `core.ts:591` `readonly handlers: Handlers = {` through line 880; `core.ts` is 1 640 lines.
- `policy.ts:20-163` repeats all 142 keys.
- CLAUDE.md, "Work style": "Append-only registries conflict most: `Methods` in `rpc.ts`, `Handlers` in `core.ts` …"
- docs/06: plugins will "talk to the core over typed RPC, with one schema shared by the UI and the plugins"; today a plugin would have to edit `rpc.ts`.

**Proposal.** Split by service without changing a byte on the wire: `packages/protocol/src/api/pane.ts` exports `interface PaneMethods { "pane.create": …; … }` and `interface PaneEvents { "pane.output": …; … }`; `rpc.ts` becomes `export interface Methods extends PaneMethods, AgentMethods, … {}` and `export type CoreEvent = Events[keyof Events]` from an `Events` map built the same way. `keyof Methods` is unchanged, so `Handlers`, `REMOTE_ACCESS` and every client compile as before. In the core, each service module exports `handlers: Handlers<PaneMethods>` (a generic `Handlers<M>`), and `core.ts` composes `{ ...paneHandlers(this), ...agentHandlers(this), … } satisfies Handlers`: exhaustiveness holds at the spread site. `REMOTE_ACCESS` can be composed the same way from per-service `access` tables, keeping the fail-closed total type. The connection-aware special cases in `#afterCall` (`fs.watch`, `data.subscribe`, `window.follow`, `events.subscribe`, `remote.bootstrap`, `magic.previewer`) become an optional `after(conn, params, result)` next to each handler, so `core.ts` stops naming methods. Add a size ratchet: no `api/*.ts` over 150 lines, `core.ts` under 900. This is the contribution pattern of 00-research §10 at the scale cmd needs, and it is what docs/06's plugins will register through.

**Success criteria.**
- [ ] `packages/protocol/src/api/` exists with one file per prefix; `rpc.ts` is under 120 lines and defines `Methods` and `Events` by composition only.
- [ ] `grep -c '"[a-z]*\.[a-zA-Z]*":' packages/core/src/core.ts` is 0 (no method names in `core.ts`); `wc -l packages/core/src/core.ts` under 900.
- [ ] `pnpm typecheck` fails when a method is added to an `api/*.ts` without a handler or a policy entry (demonstrated in the PR by a deliberate omission).
- [ ] `remoteEventVisible` is a table over `keyof Events`, not a switch.
- [ ] A ratchet test fails when any `api/*.ts` exceeds 150 lines.

### AR1-02-06 · One core connection per app, filtered per window, over MessagePorts

- **Status:** open
- **Severity:** medium
- **Effort:** L
- **Where:** `apps/desktop/src/preload/index.ts:38-78`, `apps/desktop/src/main/index.ts:472,524,687`, `packages/core/src/core.ts:1546-1554`, `apps/desktop/src/renderer/src/settings/useSettings.ts:34`, `apps/desktop/src/renderer/src/workbench/Workbench.tsx:46`, `packages/core/src/windows/manager.ts:146`

**Problem.** Each renderer window opens its own socket and subscribes; main opens five more. The core therefore writes every event N times, and each window JSON-parses every event, including `pane.output` for panes it does not show and `window.updated` for Magic windows, whose `state` carries the widget's whole `html` and `lastData` (~225 KB measured). Eleven of the thirty events push whole objects or whole lists (`pane.updated`, `agent.updated`, `window.updated`, `workspace.updated`, `settings.updated`, `remote.updated`, `widget.library`, `ai.updated`, `secrets.updated`, `search.status`, `core.startup`); `pane.updated` fires per usage sample every 2 s per pane and on each title change ("Agents animate a spinner in their title many times a second", `store.ts:420`). Filtering exists only by event type (`events.subscribe {types}`) or, for remote sessions, by followed window; a local window cannot say "only workspace X". The preload design also forces `sandbox: false` on every app window (the security side is doc 09; see doc 09).

**Evidence.**
- `#broadcast` (`core.ts:1549-1553`) loops over `#subscribers` and writes the same line to each; `Workbench.tsx:46` and `store.ts:553` subscribe to everything; `useSettings.ts:34` filters by five types.
- Main's connections: `index.ts:165,241,284`, `crash.ts:127`, `updater.ts:123`, `workspaces.ts:270`, `preview.ts:70` (each with its own reconnect loop).
- `windows/manager.ts:146` `this.emit("updated", { ...w })`: the whole window, state included; `MagicState.html` and `lastData` live in that state (`magic.ts:88-97`).
- `main/index.ts:472` `sandbox: false, // preload talks to the core socket via node:net`.
- docs/13:263: "The whole unfiltered event stream 15–30 KB/s, dominated by `magic.data` (~225 KB per event)"; the remote path solved it with `window.follow` (`core.ts:1407-1409`) and the local path did not.

**Proposal.** Let one process own the socket: a `UtilityProcess` "core link" started by main (00-research §1, [E-PROC]: the recommended home for a long-lived channel that must not sit on main's input thread), which connects once, subscribes once, and hands every window a `MessagePort` (`postMessage` with transfer, [E-PORTS]). Windows call `port.postMessage({id, method, params})` and get replies and events back; the link multiplexes ids. It knows which workspace each window shows (main already does, `workspaces.ts`) and forwards `pane.output`/`magic.*`/`window.updated` only to windows that follow those ids, using the `window.follow` semantics the core already has, so the local path and the remote path become the same path. Main's five connections collapse into the link. Parse happens once; structured clone to each port is cheaper than N × `JSON.parse` of 225 KB. Make `window.updated` carry a `state` patch (`{id, title?, state?: Partial, kind?}`) with a `full: true` flag on replace, and send `widget.library` as `{added, removed, changed}`; `pane.updated`'s usage can move to a `pane.usage` event that only the Task Manager subscribes to. The renderer keeps `CmdBridge` as its contract (docs/13:531 already asks for `subscribe()` on the bridge so the web bridge can differ); only the preload changes, and it can then run sandboxed. Do this after AR1-02-01/02, which define the stream semantics the link forwards.

**Success criteria.**
- [ ] `lsof -U -p <core pid>` shows one connection from the app with two windows open (plus the CLI's), where today it shows ≥ 7.
- [ ] `grep -n "sandbox: false" apps/desktop/src/main/index.ts` returns nothing.
- [ ] With two app windows on different workspaces and `yes` in one pane, the other window's `countEvent("pane.output")` (`store.ts:413`) stays at 0.
- [ ] `window.updated` for a Magic refresh is under 2 KB on the wire (measured in a core test with a 200 KB `lastData`).
- [ ] `pnpm e2e` and `pnpm e2e:motion` pass; `boot:terminals` in `perf.mjs` is not slower than before.

### AR1-02-07 · One client library: reconnect, subscribe, hello, timeouts

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/protocol/src/client.ts:23-29`, `packages/protocol/src/node.ts:47-66`, `apps/desktop/src/preload/index.ts:51-78`, `apps/web/src/connection.ts:75-104`, `apps/desktop/src/main/crash.ts:120-135`, `apps/desktop/src/main/updater.ts:118-133`, `apps/desktop/src/main/workspaces.ts:265-285`, `packages/core/src/agents/hook-main.ts:35-50`, `packages/core/widget-runtime/cmd.ts:453-473`

**Problem.** `client.ts` is a real shared request/response and event pump, but everything above it is hand-rolled per client. Reconnect-and-resubscribe exists five times (preload, web `Connection`, and three `attach()` loops in main), each with its own backoff and each re-running `events.subscribe` by hand; the CLI has none and exits on a dropped socket. Framing (`JSON.stringify({jsonrpc:"2.0", id, …}) + "\n"` and a newline scanner) is reimplemented in `hook-main.ts` (deliberately minimal), the Deno widget runtime, `remote/session.ts`'s `eventLine`, and two scripts. `RpcClient.call` has no timeout: a core that stops answering hangs `cmd wait` beyond its own `--timeout`, hangs the renderer's `pane.snapshot` loop, and `connect()` has no connect timeout either. Subscriptions after a reconnect are re-established by each caller (`reopenDataSubs()` in the store, nothing in the CLI's `cmd data subscribe`).

**Evidence.**
- Files containing `jsonrpc: "2.0"` outside tests: `core.ts`, `client.ts`, `rpc.ts`, `remote/session.ts`, `widget-runtime/cmd.ts`, `agents/hook-main.ts`, `scripts/agent-lab.mjs`, `scripts/perf/stress-core.mjs`.
- Reconnect loops: `preload/index.ts:57-74` (20 ms × 1.15ⁿ, cap 500), `web/connection.ts:90` (1 s × 2ⁿ, cap 30 s), `crash.ts:133`/`updater.ts:131` (1 s), `workspaces.ts:282` (250 ms).
- `client.ts:23-29`: `call()` creates a pending entry with no timer; `fail()` is the only way out.
- `cli/main.ts:158-161`: one `connect()`; `cmd events`/`data subscribe` end when the core restarts (`await closed`).

**Proposal.** Grow `client.ts` into the one client: `RpcClient` keeps the pump; add `CoreClient` (transport-agnostic, given a `connect(): Promise<Transport>` factory) that owns reconnect with one backoff, calls `core.hello` (AR1-02-03), re-issues `events.subscribe {types}` and every live `data.subscribe`/`data.subscribeView`/`fs.watch`/`window.follow` it has been asked for, and exposes `status`, `onEvent`, `call(method, params, {timeoutMs})` with a default timeout and `has()`. `node.ts` provides the socket transport, `apps/web` the Noise transport, the preload uses `CoreClient` (or the link of AR1-02-06 does). Delete the three `attach()` loops in main. Keep `hook-main.ts` minimal but have it import the framing helpers (`encodeRequest`, `lineSplitter`) rather than inline them; the Deno runtime imports the same two functions from a browser-safe `client.ts` (it already has no Node imports). Then "a fourth client" costs a transport, not a client.

**Success criteria.**
- [ ] `grep -rl 'jsonrpc: "2.0"' packages apps --include='*.ts' | grep -v test` lists only `client.ts` and `core.ts`.
- [ ] One reconnect implementation: `grep -rn "setTimeout(attach\|setTimeout(open" apps/desktop/src` returns nothing.
- [ ] `client.call()` rejects with `RpcError(kind: "timeout")` after the default timeout (test with a server that never answers); `connect()` rejects after 5 s against a listening-but-silent socket.
- [ ] `cmd data subscribe` survives a core restart (test: restart the core, record an event, assert it is printed).
- [ ] The store's `reopenDataSubs()` is gone; subscriptions are re-established by the client.

### AR1-02-08 · Bound every list and page the ones that grow

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/protocol/src/rpc.ts:93,120,272,292,341,353,431,475-489`, `packages/core/src/core.ts:654,850-853`, `packages/core/src/core.ts:863-879`

**Problem.** 17 methods return a whole collection with no `limit` or cursor: `pane.list`, `agent.list`, `window.list`, `workspace.list`, `widget.list`, `fs.list`, `agents.homes`, `hooks.status`, `window.types`, `remote.devices`, `ai.models`, `data.explain`, `journal.history`, `agents.coverage`, `ui.get`, `events.subscribe`, `remote.bootstrap`. Most are small by nature; four are not: `fs.list` returns every entry of a folder (`node_modules`, `~/Library`), `workspace.list {closed: true}` returns every workspace ever closed until someone runs `forget`, `ui.get` returns every UI key ever set (each up to 64 KiB, `core.ts:854`; the count is unbounded), and `events.subscribe`/`remote.bootstrap` return all of the above plus settings on every reconnect, on a phone too. Of the methods that take `limit`, only `data.view` (1000), `data.entities` (1000), `agents.export` (10 000) and `journal.days` (60) clamp it; `data.query`, `search.*`, `remote.log` and `journal.events` pass the client's number through (`"data.query": (p) => this.data.query(p.query)`), so `cmd data ai` asks for `limit: 100_000` (`cli/data.ts:303`) and gets it as one JSON line.

**Evidence.**
- `rpc.ts:353` `"fs.list": { params: { path: string }; result: { …; entries: FileEntry[] } }`.
- `core.ts:654-656` and the lack of `Math.min` in the `data.query`, `search.query`, `remote.log` handlers vs. `core.ts:694` (`agents.export`) and `core.ts:1490` (`#viewRows`).
- `cli/data.ts:303` `limit: 100_000`; `cli/agents.ts:189` `activity(client, t, 100_000, true)`.
- `rpc.ts:432-433` `ui.set … ≤ 64 KiB` per value, no cap on keys.

**Proposal.** A rule in `rpc.ts`'s header: a result that is a list has either a documented natural bound or `{limit?, after?}` in and `{items, next}` out, and the handler clamps `limit` (one helper, `page(p, 200, 1000)`). Apply it to `fs.list` (`limit`, `after: name`, plus `total`, so the files window can show "1 200 more…"), `workspace.list {closed}` (default the 20 most recent closed), `data.query`/`search.*`/`remote.log`/`journal.events` (clamp to 1 000; the CLI's export already pages by `seq`, make `cmd data ai` aggregate in the core via a `data.aggregate` or page). Cap `ui.set` to 256 keys and 1 MiB total, and move the only large UI values (layouts) to `workspace.view`. Keep `events.subscribe`'s shape but let it take `{workspaceId?}` so a second window bootstraps with one workspace's panes and windows (ties into AR1-02-06).

**Success criteria.**
- [ ] `fs.list` on a folder with 50 000 entries returns in under 50 ms with `next` set (test with a temp dir).
- [ ] A test asserts every handler whose param type has `limit` clamps it: calling with `limit: 1e9` returns at most the documented cap.
- [ ] `ui.set` refuses the 257th key with `too-large`; a migration moves existing layout keys.
- [ ] `rpc.ts` header states the list rule; `grep -c "next:" packages/protocol/src/rpc.ts` ≥ 6.

### AR1-02-09 · Resolve references in the core, not in each client

- **Status:** open
- **Severity:** low
- **Effort:** M
- **Where:** `packages/cli/src/main.ts:480-494`, `packages/cli/src/main.ts:255-258`, `packages/cli/src/main.ts:667-686`, `packages/cli/src/main.ts:553-557`, `packages/cli/src/agents.ts:38-59`, `packages/protocol/src/names.ts:406-427`, `packages/cli/src/widget.ts:535-538`

**Problem.** The CLI accepts the references docs/08 and docs/32 promise (id prefix, name, folder) but resolves them client-side by fetching whole lists: `resolveAgent` and `resolvePane` each call `agent.list` and `pane.list`; `cmd wait a b c` resolves per argument (`Promise.all(pos.map(resolveAgent))`: six list calls); `findWorkspace` fetches every workspace including closed ones; `remote` subcommands fetch all devices; `agents.ts:target` falls back to `data.entities {limit: 1000}` twice. `matchAgents` lives in `@cmd/protocol` but is used only by the CLI, so the renderer's palette, the web client's compose bar and a future MCP server will each reinvent "which agent did you mean" or get it wrong (the `pickAgent` ambiguity error is CLI-only). This is the one place the CLI duplicates logic that belongs behind the socket; the rest of the CLI (`cmd magic`, `cmd widget`) deliberately runs core modules in-process and is fine.

**Evidence.**
- `main.ts:480-485`, `487-494`: two `Promise.all([agent.list, pane.list])` per reference; `main.ts:257` maps over arguments.
- `grep -rl matchAgents apps packages` → only `packages/cli/src/agents.ts`.
- `agents.ts:53-57`: `data.entities { kind, limit: 1000 }` to find an exited agent by prefix.

**Proposal.** Add `resolve { refs: string[]; kinds?: ("agent"|"pane"|"workspace"|"device"|"widget")[]; callerPaneId? } → { ref, match: {kind, id} | null, ambiguous?: {kind,id,label}[] }[]` to the core, implemented with `matchAgents` and the workspace/device/widget rules from `main.ts`, including exited agents from the entity store. Then let the host-agent methods accept it directly: `agent.send`, `agent.kill`, `agent.wait`, `pane.read`, `agent.rename` take `agentId | {ref}` and fail with `ambiguous` (AR1-02-04's kind) listing the candidates. The CLI deletes `resolveAgent`, `resolvePane`, `findWorkspace`, `find` and `target`; the renderer's palette and the web client use the same method.

**Success criteria.**
- [ ] `cmd wait a b c` makes one `resolve` call and one `agent.wait` (asserted with a recording fake core in `packages/cli/test`).
- [ ] `grep -n "function resolveAgent\|function resolvePane\|function findWorkspace" packages/cli/src/main.ts` returns nothing.
- [ ] A core test covers id, prefix, name, former name, folder, closed workspace and the ambiguous case.
- [ ] `matchAgents` has a second caller outside the CLI, or moves into the core.

### AR1-02-10 · Test the wire and the CLI

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/protocol/` (no `test/`), `packages/cli/test/agents.test.ts`, `packages/core/test/remote.test.ts`, `e2e/smoke.mjs`

**Problem.** The contract has no tests of its own, and the server's framing path is tested only through the remote policy. Nothing asserts: a malformed line is ignored and the connection survives; an oversized line is refused; an unknown method's code; a request without `id`; reply order against events; `events.subscribe {types}` filtering; `#afterCall` cleanup on close (watches, subscriptions, follows, previewers); `lineSplitter` with CRLF, partial and multi-line chunks. The CLI, which is the agents' interface and the hook entry, has 3 tests, all of `pickAgent`; `main.ts`'s 734 lines of parsing, output and exit codes are untested, and no e2e script runs the CLI against a core (`e2e/smoke.mjs` matches `"cmd"` only inside fixture JSON).

**Evidence.**
- `ls packages/protocol/test` → no such directory; `grep -rln "RpcClient\|lineSplitter" packages/*/test` → `remote.test.ts` only.
- `grep -rn "unknown method\|-32000\|-32601" packages/core/test packages/cli/test` → nothing.
- Test counts: `core.test.ts` 7, `remote.test.ts` 9, `data-subscriptions.test.ts` 7, `cli/test/agents.test.ts` 3.
- `grep -c "cli/src/main\|pnpm cmd" e2e/*.mjs` → 0 in every script.

**Proposal.** `packages/protocol/test/client.test.ts` for `RpcClient`/`lineSplitter` (chunking, CRLF, max line, pending rejection on `fail`, timeout once AR1-02-07 lands); `packages/core/test/wire.test.ts` that starts a `Core` with `listen()` on a temp socket and drives it with raw `net` writes for the malformed/oversized/unknown/no-id cases, the ordering guarantee of AR1-02-02, subscribe filters and close-cleanup (assert `watches`, `#dataSubs` sizes through `core.info` or a test accessor). For the CLI, extract `run()` so it takes `argv` and a client (today both are module globals, `main.ts:87-145`), then table-test each command against a fake `client` that records calls and returns fixtures: arguments → calls made, stdout, exit code. Add one e2e step that runs `node packages/cli/src/main.ts ls --json` and `cmd new` against the e2e core and checks the pane appears in the UI, which also pins the `CMD_SOCKET`/`CMD_PANE_ID` contract.

**Success criteria.**
- [ ] `packages/protocol/test/client.test.ts` and `packages/core/test/wire.test.ts` exist and pass in `pnpm test`.
- [ ] `packages/cli/test/main.test.ts` covers every top-level command in `COMMANDS` (`main.ts:70`) at least once; a test fails when a command is added to `COMMANDS` without a case.
- [ ] `e2e/smoke.mjs` runs at least two CLI commands against the e2e core.
- [ ] `main.ts` exports `run(argv, client)`; `process.exit` appears only in the entry block.

## Course corrections

1. **Define the stream semantics, then enforce them**: offsets on `pane.output`/`pane.snapshot` and a documented ordering contract (AR1-02-02), flow control and a frame limit on every connection by sharing the remote writer (AR1-02-01). These are the two defects that lose or pile up bytes today.
2. **Negotiate on `core.hello` and type the errors** (AR1-02-03, AR1-02-04): a protocol number, a method list and real error codes replace the four field probes and make "old core", "bad params" and "not found" three different things for the app, the CLI and the hosted web client.
3. **One client, one connection per app** (AR1-02-07, then AR1-02-06): grow `client.ts` into the client every process uses, then let a utility process own the socket and hand windows MessagePorts with per-window filtering. This removes five reconnect loops, N-fold fan-out of 225 KB events, and the reason for `sandbox: false`.
4. **Compose the contract per service** (AR1-02-05) with a size ratchet, so the plugin host of docs/06 and an MCP server register methods from their own folders instead of editing three central lists.
5. **Bound lists, resolve in the core, test the wire** (AR1-02-08, AR1-02-09, AR1-02-10).

## Quick wins

- Part of AR1-02-01: `MAX_LINE` in `lineSplitter` and the scan-offset fix (under an hour, with a test).
- Part of AR1-02-04: map `unknown method` to `-32601` and stop recording a crash for it; `RemoteDenied` already shows the pattern.
- Part of AR1-02-03: replace `VERSION = "0.0.1"` with `process.env.CMD_APP_VERSION ?? "source"` in `core.hello` and add `protocol: 1`.
- Part of AR1-02-07: a default `timeoutMs` on `RpcClient.call` and a 5 s connect timeout in `node.ts`.
- Part of AR1-02-08: clamp `limit` in the `data.query`, `search.*`, `remote.log` and `journal.events` handlers with one helper.
- Part of AR1-02-10: `packages/protocol/test/client.test.ts` for `lineSplitter` and `RpcClient` (half a day).
