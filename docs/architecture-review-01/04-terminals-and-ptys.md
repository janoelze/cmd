# 04 Terminals and PTYs

**Score: 6/10** · reviewed 2026-10-10 against commit ddb7832 · scope: the terminal data path from PTY to pixels: PTY host, headless mirror, OSC scanning, shell integration, screen saves and restore, foreground detection, the renderer's xterm.js layer

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 7/10 | `Term`/`TermBackend` is a clean seam; the host is small; the renderer layer is one 859-line singleton |
| Correctness & robustness | 5/10 | Attach can lose bytes under output; query replies come from 0..N UIs; an OSC over 8 KB rings the bell; zsh reports a wrong cwd for `#`, `?`, `%` |
| Performance | 6/10 | The host keeps up (481 MB `cat` at 66 MB/s, echo p50 0.7 ms meanwhile), but every window mirrors every pane, and busy agent screens are serialized every 10 s for nothing |
| Security | 7/10 | Shell requests are token-gated, OSC 52 reads are refused, paste protection is good; OSC 8 opening is doc 09's |
| Testability & tests | 6/10 | Host, restore, OSC and shells are well tested (74 cases in 8 files); `terminals.ts` has no test at all |
| Extensibility | 6/10 | Adding an OSC means editing two parsers (core scanner, renderer xterm) and sometimes a third (host) |
| Code health | 7/10 | Terse, well commented, honest about trade-offs; a few stale comments and scattered constants |

## What this system is

Terminals run in the **PTY host** (`packages/core/src/terminals/host.ts` 222 lines, entry `host-main.ts` 53), a detached process that owns each PTY (`pty.ts` 55, node-pty) and mirrors its output into an `@xterm/headless` terminal (`local.ts` 165) with the serialize and unicode11 addons. The core talks to it over a Unix socket with newline-delimited JSON (`remote.ts` 352, `HOST_PROTOCOL = 2`); `local.ts` doubles as the in-process backend for tests. `panes.ts` (788) is the core's pane manager: spawn with shell integration (`shells.ts` 71, scripts in `packages/core/shell/{zsh,bash,fish}`), the OSC scanner per pane (`osc.ts` 215), foreground polling (`agents/procinfo.ts` 226 over the native helper `native/procinfo.c` 222), command capture for the command log (`commands.ts` 129) and agent output recording (`data/sources/pane-output.ts` 144), and screen saves every 10 s for `restore.ts` (184), which reattaches or resurrects panes at startup. In the app, `renderer/src/terminals.ts` (859) keeps one xterm.js `Terminal` per pane per window (WebGL pool of 8, DOM otherwise), with find, links (`links.ts` 96), paste checks (`paste.ts` 50) and the sequences xterm.js leaves to embedders; `TerminalView.tsx` (99) borrows its element. Design: docs/02-terminal-foundations.md (headless state in a long-lived process, "add flow control whatever you choose"), docs/01-prior-work-ghostty-agents.md, docs/14-performance.md (bench and measured numbers).

**One byte, PTY to pixels.** node-pty in the host decodes to a JS string (copy 1) → `vt.write` (headless parse) and `JSON.stringify({ev:"data",t,d})` (copy 2; ESC becomes `\u001b`, measured 1.61× inflation on coloured output) → socket → core: `setEncoding` decode, `lineSplitter` concat and slice, `JSON.parse` (copies 3-5) → `OscScanner.feed` char loop (288 MB/s measured), command capture, `PaneOutputRecorder` → `#broadcast` stringifies once (copy 6) and writes it to each window's socket → preload decode and `JSON.parse` per window (copy 7) → `contextBridge` structured clone (copy 8) → `xterm.write` → WebGL. Two JSON round trips, three UTF-8 decodes, three full VT parses (host, renderer × windows) plus the core's scanner. No ACK anywhere; no coalescing locally. The host has *implicit* backpressure: node-pty reads only when the host's one thread is free, so a busy headless parser stops reading the PTY and the kernel blocks the writer (measured below). Throughput: docs/14 measured 54 MB/s end to end, host CPU-bound; this review measured 481 MB of coloured `cat` through a `LocalBackend` at 66 MB/s with the headless terminal caught up 5 ms after exit, and another terminal's echo at p50 0.7 ms / max 1.6 ms during the flood (idle: 0.1 ms).

## What is good

- **The headless mirror lives in the host, not the core.** UIs and `pane.read` get real terminal state (`snapshot`, `read`) that survives a core restart; `restore: true` serializes the normal buffer only, without modes, and pads below an agent's input box (`local.ts:84-91`). This is the VS Code reconnection model (00-research §5) and better than raw replay; `vt.test.ts` pins the TUI-frame and stale-mode cases.
- **The host is deliberately small and versioned**: one owner connection, takeover with a `replaced` event, idle exit, `HOST_PROTOCOL` checks and the code-folder-gone rule (`remote.ts:109-111, 159-166`), with 10 integration tests in `ptyhost.test.ts`.
- **Shell integration does not skip the user's config**: ZDOTDIR trick for zsh, `--posix`+`ENV` for bash ≥ 4 and `--rcfile` with login emulation for Apple's bash 3.2, `XDG_DATA_DIRS` for fish (`shells.ts:41-71`); PS0 / bash-preexec / DEBUG trap in that order; per-pane history in each shell's own format. Ghostty's and Kitty's approach, done carefully.
- **Requests from the shell are authenticated** by a per-pane token (`panes.ts:469-471`), so `cat`-ing a file can't trigger `open`.
- **Restore semantics are thoughtful**: commands are offered, never run; agent sessions resume by their own command; copied databases don't resurrect someone else's agents (`restore.ts:15-19`); each pane restores independently.
- **WebGL is pooled under Chromium's limit** (8 of ~16), a lost context falls back to DOM, and dropped contexts are released explicitly (`terminals.ts:622-662`).
- **Paste protection and drops** are pure, tested functions (`paste.ts`, `links.ts` with `paste.test.ts`, `links.test.ts`): copy this split for the rest of `terminals.ts`.
- **A real bench exists** (`scripts/perf/bench.ts flood|memory`, `e2e/perf.mjs`) with numbers in docs/14. Other systems should have one.

## Issues

### AR1-04-01 · Number the output in the PTY host so a snapshot and the stream join exactly

- **Status:** open
- **Severity:** high
- **Effort:** M
- **Where:** `packages/core/src/terminals/local.ts:37-40`, `packages/core/src/terminals/local.ts:77-93`, `packages/core/src/terminals/local.ts:125-128`, `packages/core/src/terminals/host.ts:155`, `apps/desktop/src/renderer/src/store.ts:408-416`, `apps/desktop/src/renderer/src/store.ts:587-596`
- **Depends on:** AR1-02-02 (same goal; this issue says where the offset must come from)

**Problem.** A window that attaches while a pane prints can lose output, and the loss is in the host, below where AR1-02-02 puts its fix. The host forwards each chunk to the core the moment node-pty delivers it (`host.ts:155`), while `vt.write(d)` only queues it: xterm parses in 12 ms slices, so the headless terminal runs behind the stream whenever output is heavy. `snapshot()` waits for a flush marker and serializes in a later microtask; chunks queued after the marker but still unparsed at that point were already sent as events *before* the snapshot reply. The renderer drops every event that arrives while it awaits the snapshot (`store.ts:415`), so those bytes are in neither. AR1-02-02 proposes an offset counted in the core, but the core cannot know how many bytes the host's serializer had parsed; only the host can.

**Evidence.** `local.ts:37-40` writes to the vt and fans out in the same callback with no record of what was parsed; `local.ts:126-127` `#flush` is `vt.write("", resolve)`, and `serialize` runs after the `await` (`local.ts:78-84`), after xterm may have parsed some but not all later chunks. `@xterm/headless` 6.0.0 processes the write buffer in timed slices (the same code throws "write data discarded" past 5e7 pending bytes). A 481 MB `cat` kept the host's parser busy for the whole 7.3 s run, which is the state every pane of a busy agent is in during a core restart. No message in `host.ts`'s protocol carries a position.

**Proposal.** Make the host the clock. Each `LocalTerm` keeps `fed` (bytes handed to the vt) and `parsed` (advanced in each chunk's write callback: `vt.write(d, () => (this.#parsed += d.length))`). Data events carry their end offset (`{ev:"data", t, d, o}`), `snapshot` returns `{data, cols, rows, offset: parsed}` taken synchronously, so it is exact without the flush dance. The core passes `o` through as `pane.output.offset` and `pane.snapshot.offset` (this is AR1-02-02's wire change, with the number sourced here). The renderer keeps events that arrive while it waits, and when the snapshot lands writes only the part of each with `offset > snapshot.offset` (slicing the one that straddles). Bump `HOST_PROTOCOL` to 3. The same offsets give AR1-02-01's resync a precise restart point. Prior art: VS Code's pty host replays from a serialized state plus the events after it, keyed by sequence (00-research §5 [VSC-TERM]).

**Success criteria.**
- [ ] `host.ts` data events and `snapshot` replies carry an offset; `HOST_PROTOCOL` is 3.
- [ ] A test in `ptyhost.test.ts` floods a terminal (≥ 50 MB), takes 20 snapshots during the flood, and for each, snapshot + events after its offset replayed into a fresh headless terminal equals the host's final `read(…)`.
- [ ] `grep -n "awaitingSnapshot.has" apps/desktop/src/renderer/src/store.ts` returns nothing (events are buffered and trimmed by offset, not dropped).
- [ ] `LocalTerm` has no `#flush` call in `snapshot`.

### AR1-04-02 · Mirror only the panes a window shows, not every pane in every window

- **Status:** open
- **Severity:** high
- **Effort:** M
- **Where:** `apps/desktop/src/renderer/src/store.ts:561`, `apps/desktop/src/renderer/src/store.ts:583-596`, `apps/desktop/src/renderer/src/store.ts:414-415`, `apps/desktop/src/renderer/src/terminals.ts:273-294`, `apps/desktop/src/renderer/src/terminals.ts:259-270`
- **Depends on:** AR1-04-01

**Problem.** Each app window (one per workspace with ⇧⌘N) creates a full xterm.js terminal for every pane in every workspace at boot, snapshots each, and parses all their output for as long as it lives. Memory and CPU grow with panes × windows, the boot fetch grows with all panes, not the visible ones, and each of those hidden terminals answers queries (AR1-04-03). The headless mirror in the host already is the source of truth, so the renderer copy is a cache that need not be total.

**Evidence.** `store.ts:561` holds and `store.ts:590` snapshots `snap.panes`, all panes, ranked but not filtered by workspace; `store.ts:415` writes every `pane.output` into `terminals.get(paneId)`, which creates the terminal if missing (`terminals.ts:273-276`) with `scrollback: terminal.scrollback` (default 10,000). Measured: a full 200×50 headless terminal with 5,000 lines of coloured scrollback costs 14 MB (heap + array buffers); a 5,000-line snapshot is 0.93 MB of JSON and 29 ms to serialize in the host. docs/14 records "the renderer holds a second copy per window". At 30 panes with full scrollback a window holds roughly 30 × 28 MB ≈ 0.8 GB, and boot moves ~28 MB of snapshots through the socket per window.

**Proposal.** Make renderer terminals a bounded cache over the host's state. `Terminals.get` no longer creates on output: output for a pane with no live instance is dropped (its state is in the host). A terminal is created on first `attach` from a snapshot (AR1-04-01's offsets make that safe at any moment), kept while shown, and after it is hidden kept in an LRU of `terminal.warm` instances (default 8, matching the WebGL pool), then disposed. Boot snapshots only the panes of this window's workspace, selected first. Thumbnails and cards that need "last lines" use `pane.read` (text) instead of a live terminal. Event filtering per window (AR1-02-06, see doc 02) then removes the parse cost too. Prior art: VS Code revives terminals from serialized state on demand; tmux clients draw only what they show.

**Success criteria.**
- [ ] With 30 panes across 3 workspaces and one window, `terminals` holds at most `terminal.warm` + visible instances (exposed through the perf counters in `perf.ts`).
- [ ] `boot:terminals` in `e2e/perf.mjs` snapshots only the window's workspace panes (count asserted).
- [ ] Switching to a workspace whose terminals were disposed shows their content identical to `pane.read` (e2e).
- [ ] Renderer process memory with 30 full terminals is reported in docs/14 before and after, and is at least 50% lower after.

### AR1-04-03 · Answer terminal queries in exactly one place: the host's headless terminal

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/terminals/local.ts:28-42`, `packages/core/src/osc.ts:46-57`, `packages/core/src/osc.ts:141-152`, `packages/core/src/panes.ts:465-468`, `apps/desktop/src/renderer/src/terminals.ts:333`, `apps/desktop/src/renderer/src/terminals.ts:826-838`, `packages/core/src/core.ts:1376-1380`

**Problem.** Programs that ask the terminal something (cursor position `CSI 6n`, status `CSI 5n`, mode queries `DECRQM`, size reports, device attributes) get one answer per UI that holds an xterm for the pane, and none when no UI does. With two app windows (or a paired phone) a `CSI 6n` gets two `ESC[r;cR` replies and the second lands in the program's input as garbage (`;1R` at a prompt); with the app closed, a program that waits for the reply stalls until its own timeout. The core patches only DA1/DA2, by hand, in a second parser, and the renderer then has to silence xterm's own DA answers. The headless terminal in the host already computes the correct replies from the true state and nobody listens.

**Evidence.** Measured: writing `\x1b[6n\x1b[c\x1b[?2004$p` to `@xterm/headless` emits `["\x1b[1;1R","\x1b[?1;2c","\x1b[?2004;2$y"]` on `onData`; `LocalTerm` never subscribes to `vt.onData`. The renderer forwards every xterm reply as input (`terminals.ts:333`), for every pane in every window (AR1-04-02). `core.ts:1378` filters `^(\x1b\[[\d;?>]*[IOcRn])+$` out of "typing at the Mac", which is the core acknowledging that UIs send reports. `osc.ts:152` hard-codes `DEVICE_REPLIES` "the same as the UI's terminal would give", and `terminals.ts:826-838` re-registers a CSI handler after each addon to keep xterm.js quiet.

**Proposal.** In `LocalTerm`, `vt.onData((r) => pty.write(r))`: the host answers DSR, DA1/DA2, DECRQM and XTWINOPS character-size reports from the real state, with or without a UI. Give the headless terminal what it can't know: XTVERSION and the colour-scheme/OSC 10/11 answers need the app version and theme, which the core sends with a `configure` host message on start and on theme change. In the renderer, register swallowing handlers for every report-generating sequence (CSI `c`, `>c`, `n`, `$p`, `>q`, `t` for character sizes) so xterm.js never answers; keep only pixel-size reports (`CSI 14t/16t`), which need a UI, and answer those from the window that last sized the pane. Delete `deviceQuery`, `DEVICE_REPLIES`, the CSI state in `OscScanner` and `#quietDA`. Bump `HOST_PROTOCOL` (combine with AR1-04-01).

**Success criteria.**
- [ ] A `ptyhost.test.ts` case runs `printf '\e[6n'; read -rs -d R r; echo "got$r"` in a terminal with no UI attached and reads `got` with a cursor position back.
- [ ] An e2e with two app windows runs the same and the pane's input receives exactly one reply.
- [ ] `grep -n "DEVICE_REPLIES\|deviceQuery\|quietDA" -r packages/core/src apps/desktop/src` returns nothing.
- [ ] `core.ts`'s "typing at the Mac" filter no longer needs the report regex (or the regex is deleted).

### AR1-04-04 · Stop an OSC longer than 8 KB from ringing the bell

- **Status:** in progress (osc-fixes)
- **Severity:** medium
- **Effort:** S
- **Where:** `packages/core/src/osc.ts:89-99`, `packages/core/src/osc.ts:34-79`, `packages/core/src/notifications.ts:189-198`

**Problem.** When an OSC body passes `MAX_OSC` (8192), the scanner leaves OSC state and scans the rest of the body as plain text, so the BEL that terminates it counts as a bell. iTerm2 inline images (`imgcat`, OSC 1337, which the renderer's image addon supports with `iipSupport: true`) and any OSC 52 copy over ~6 KB of text are longer than that. The pane then gets an urgent "Bell" attention mark and, with `notifications.bell: notify`, a notification. The scanner also ignores CAN/SUB (which abort a sequence in xterm.js, so an aborted OSC swallows text up to the next BEL) and the 8-bit C1 forms (U+009B CSI, U+009D OSC, U+0090 DCS, U+009C ST) that xterm.js's parser honours, so the two parsers can disagree about where a string ends.

**Evidence.** Measured with `OscScanner` at ddb7832: `feed("\x1b]1337;File=inline=1:" + "A".repeat(20000) + "\x07")` → `[{"type":"bell"}]`; a 10 KB OSC 52 → `[{"type":"bell"}]`. `osc.test.ts` has 15 cases; none passes the limit, CAN/SUB or C1.

**Proposal.** On overflow, switch to a `#skipOsc` state that discards until BEL or ST instead of dropping to ground state; treat CAN (0x18) and SUB (0x1a) as aborting any sequence; map U+009B/U+009D/U+0090/U+009E/U+009F/U+0098 to their 7-bit equivalents and U+009C to ST. The more powerful route is to stop scanning in the core at all: the host's headless terminal already parses every byte with xterm.js's full VT500 state machine, and `registerOscHandler` works there, so the host could emit `{ev:"osc", t, code, data}` and `{ev:"bell"}`; that removes a second parse of every byte from the core's thread and keeps the two views consistent by construction. Do the S fix now; move OSC parsing to the host in the same `HOST_PROTOCOL` bump as AR1-04-01/03 if that lands.

**Success criteria.**
- [x] `osc.test.ts` has cases for a 20 KB OSC 1337 and a 10 KB OSC 52 (no events), CAN inside an OSC (following text's BEL is a bell), and C1 OSC/ST (`\u009d0;title\u009c` → title).
- [x] An e2e or core test runs `printf '\e]1337;File=inline=1:%s\a' "$(head -c 30000 /dev/zero | base64)"` in a pane and no `attention` is set.

### AR1-04-05 · Percent-encode the whole path in zsh's OSC 7

- **Status:** in progress (osc-fixes)
- **Severity:** medium
- **Effort:** S
- **Where:** `packages/core/shell/zsh/cmd-integration.zsh:16-19`, `packages/core/shell/bash/cmd-integration.bash:71-75`, `packages/core/src/osc.ts:174-182`

**Problem.** zsh, the default macOS shell, reports its cwd with only spaces encoded. In a folder whose name has `#` or `?` the core cuts the path at that character (URL fragment, query); with `%` followed by non-hex the decode throws and the cwd stops updating. The pane's cwd drives the title, "New Terminal here", git placement and the file links' resolution, so all of them point at the wrong or a stale folder. bash already encodes `%`, space, `#` and `?`; fish uses `string escape --style=url`.

**Evidence.** Measured through `parseOsc`: `7;file://host/tmp/a#b` → cwd `/tmp/a`; `/tmp/what?x` → `/tmp/what`; `/tmp/50%off` → `null` (no update). `cmd-integration.zsh:17`: `local url_path=${PWD// /%20}`.

**Proposal.** Encode every byte outside the RFC 3986 unreserved set and `/`, as VS Code's and Ghostty's zsh integrations do, e.g. `local LC_ALL=C; for c in ${(s::)PWD}; [[ $c == [[:alnum:]/._~-] ]] && u+=$c || u+=$(printf '%%%02X' "'$c")`, or the zsh-native `${(j::)${(s::)PWD}//(#m)[^A-Za-z0-9\/._~-]/%${(l:2::0:)$(([##16]#MATCH))}}` with `setopt extendedglob` local. Make bash match (it misses other reserved bytes, e.g. `;` is fine but a newline in a folder name is not). Share one test fixture for all three shells.

**Success criteria.**
- [x] `shells.test.ts` starts real zsh, bash and fish (where installed), `cd`s into `a#b`, `c?d`, `50%off`, `ü ñ`, and reads each cwd back exactly from the pane.
- [x] `grep -n 'PWD// /%20' packages/core/shell/zsh/cmd-integration.zsh` returns nothing.

### AR1-04-06 · Save screens only when they will be restored, and serialize them off the burst

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `packages/core/src/panes.ts:85-87`, `packages/core/src/panes.ts:218-221`, `packages/core/src/panes.ts:694-727`, `packages/core/src/restore.ts:99-103`, `packages/core/src/terminals/local.ts:77-93`

**Problem.** Every 10 s the core asks the host to serialize every pane that printed anything, all at once, then hashes and stores each changed screen. The panes that print constantly are working agents (a spinner keeps the pane dirty and the screen different every tick, docs/14 item 4), and their screen is the one restore never uses: a resumed agent "shows its conversation itself". The host's single thread serializes them back to back, delaying other panes' output and replies for that burst; the core then SHA-1s, parses and writes up to hundreds of KB per pane per 10 s.

**Evidence.** `restore.ts:103`: `const screen = auto ? null : store.screen(rec.id);` with `auto` true whenever the pane's agent is resumable and `restore.resumeAgents` is on (default true). `panes.ts:702-716` fires all snapshots with `Promise.all`. Measured: `serialize({scrollback: 2000, excludeAltBuffer, excludeModes})` of a 200-column coloured screen takes 12.7 ms and yields 373 KB. Ten busy agents: ~130 ms of host thread in one burst and ~3.7 MB to hash and write every 10 s, ~1.3 GB/h of WAL traffic, all discarded at the next restore.

**Proposal.** (1) Skip panes whose agent would be resumed (the tracker knows: `agents.resumeOfStored`) unless resume is off; save their screen once when the agent ends. (2) Move the change check into the host: the host keeps a per-terminal "dirty since last save" flag and hash and answers `snapshot({restore, unlessHash})` with `{same: true}` when unchanged, so unchanged screens don't cross the socket. (3) Spread the work: save one dirty pane per tick over the interval (or when a pane has been quiet for 2 s, which is when its screen is worth keeping), never all at once. Keep the save at shutdown.

**Success criteria.**
- [ ] A `restore.test.ts` case: a pane with a resumable agent and continuous output gets no `saveScreen` call in 30 s of fake time, and still restores by resuming.
- [ ] `saveScreens` never has more than one host snapshot in flight (test with a counting fake backend).
- [ ] `scripts/perf/bench.ts` with 10 spinner panes reports host CPU per minute and bytes written to `cmd.sqlite` per minute, both at least 80% lower than at ddb7832 (numbers in docs/14).

### AR1-04-07 · Make the scrollback setting mean the same after a reload

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `packages/core/src/panes.ts:80-85`, `packages/core/src/panes.ts:300-301`, `apps/desktop/src/renderer/src/terminals.ts:269`, `packages/protocol/src/settings.ts:94`

**Problem.** "Scrollback: lines kept per terminal" (default 10,000) holds only in the window that saw the output live. The host keeps `min(terminal.scrollback, max(5000, restore.scrollback))` = 5,000 lines and snapshots 5,000, so a window reload, a core restart, a new window or a newly created renderer terminal (AR1-04-02) shows half, and ⌘F finds different things in two windows on the same pane. The cut is a deliberate memory trade (docs/14 item 11), but the setting and the UI don't say so.

**Evidence.** `panes.ts:85` `SNAPSHOT_SCROLLBACK = 5000`; `panes.ts:301` `kept = Math.min(cfg["terminal.scrollback"], Math.max(SNAPSHOT_SCROLLBACK, cfg["restore.scrollback"]))`; renderer `scrollback: s["terminal.scrollback"]` (`terminals.ts:269`).

**Proposal.** One number: the host keeps `terminal.scrollback` lines and snapshots all of them, and the renderer uses the same. Pay for it by lowering the default to 5,000 (measured 14 MB per full 200-column terminal in the host) or by AR1-04-02, which removes the per-window copies that made 10,000 expensive. Delete `SNAPSHOT_SCROLLBACK`.

**Success criteria.**
- [ ] `grep -n SNAPSHOT_SCROLLBACK packages/core/src` returns nothing.
- [ ] A `vt.test.ts` case: with `terminal.scrollback = N`, after N + 100 lines a snapshot replayed into a fresh terminal has exactly N lines of scrollback.

### AR1-04-08 · Split `terminals.ts` into tested modules

- **Status:** open
- **Severity:** medium
- **Effort:** M
- **Where:** `apps/desktop/src/renderer/src/terminals.ts:1-859`

**Problem.** The renderer's terminal layer is one 859-line class plus module-level state, covering nine concerns: instance registry and hold/release (194-221), settings and WebGL pool (233-271, 622-662), link provider and path resolution (97-187), key handling (357-380), resize throttling (412-457), find (532-582), escape-sequence handlers (679-735), mouse and drops (738-809), images (811-824). None of it has a unit test, though most is testable: key mapping is a pure function of a `KeyboardEvent`, and the OSC/CSI handlers run unchanged on `@xterm/headless`. Changes to shortcuts, OSC 133 marks or click-to-move are verified only by hand or by e2e. Comments drift: line 189 says WebGL is "not the default" while `settings.ts` defaults to `webgl`.

**Evidence.** `grep -rln "terminals.ts" apps/desktop/test` returns nothing; `paste.ts` and `links.ts`, already extracted, have `paste.test.ts` and `links.test.ts`. 859 lines vs. the repo's other renderer modules (doc 08 measures the shell).

**Proposal.** A `renderer/src/terminals/` folder: `registry.ts` (create, attach, dispose, LRU per AR1-04-02), `webgl.ts` (pool and context loss), `keys.ts` (`keyAction(e, settings) → {write} | {jump} | {scroll} | "app" | "xterm"`, pure), `sequences.ts` (OSC 133/52, XTVERSION, colour scheme; takes a parser and a reply function), `links.ts` (provider; detection already split), `fit.ts` (the two throttles), `mouse.ts` (click-to-move, copy-on-select, drops). Test `keys.ts` as a table and `sequences.ts` on `@xterm/headless`.

**Success criteria.**
- [ ] No file in `renderer/src/terminals/` is over 300 lines.
- [ ] `apps/desktop/test/terminal-keys.test.ts` covers ⇧↩, ⌘⌫/⌘←/⌘→, Option-as-Meta per side and app shortcuts.
- [ ] `apps/desktop/test/terminal-sequences.test.ts` drives OSC 133 A/C/D, OSC 52 (on, off, query, over 8 MB) and CSI ?996n on a headless terminal.
- [ ] `pnpm e2e` passes.

### AR1-04-09 · Give the procinfo helper request ids and a timeout

- **Status:** open
- **Severity:** low
- **Effort:** S
- **Where:** `packages/core/src/agents/procinfo.ts:132-226`, `packages/core/src/panes.ts:483-496`, `packages/core/native/procinfo.c:51-75`, `packages/core/native/procinfo.c:203-218`

**Problem.** The core matches helper answers to requests by order alone, without a timeout. A helper that hangs (a `sysctl` on a process in an odd state) leaves `pollForeground`'s `#polling` flag set forever, so foreground and agent detection silently stop for every pane until the core restarts. A `t`/`p` request longer than the helper's 8,192-byte line buffer is read as two requests and answered twice, after which every answer goes to the wrong caller. When the foreground process exits between the two lookups, `report` prints `fi.kp_proc.p_comm` from an uninitialised `struct kinfo_proc`.

**Evidence.** `procinfo.ts:135` "answered in order"; no `setTimeout` in `ProcInfo`; `panes.ts:484` `if (this.#polling) return;` with `await Promise.all(...)` in between. `procinfo.c:204` `fgets(line, sizeof line, stdin)` with `char line[8192]`; `procinfo.c:58-61` only fills `fi` when `kinfo(fg, &fi) == 0`, and `procinfo.c:69-70` reads it regardless.

**Proposal.** Prefix requests with an id the helper echoes (`<id> <cmd> …` → `{"id":…}`), resolve by id, and time out at 1 s by killing and respawning the helper (failures counted and logged). Zero-initialise `fi` and fall back to the shell's name when it is unset; read lines with `getline` instead of a fixed buffer. Classification quality is doc 05's (see doc 05).

**Success criteria.**
- [ ] A test with a fake helper that never answers shows `pollForeground` resolving within 1.5 s and the next poll running.
- [ ] A test sends a `t` request with 3,000 pids and the next `query` gets its own answer.
- [ ] `procinfo.c` initialises `fi` (`struct kinfo_proc fi = {0};`).

## Course corrections

1. **Make the host the single source of terminal truth, with a position** (AR1-04-01, then AR1-04-03): offsets on every chunk and snapshot, and the headless terminal answering queries. One `HOST_PROTOCOL` bump carries both, and AR1-04-04's move of OSC parsing into the host if taken. This closes the byte-loss defect and the duplicate-reply defect at their root, and gives doc 02's flow control (AR1-02-01) the exact resync point it needs. For that flow control, put the PTY pause in the host: it already throttles reading implicitly; add `pty.pause()` when the core socket's `writableLength` passes a watermark (`host.ts:208-210` ignores `write`'s return today).
2. **Treat renderer terminals as a cache** (AR1-04-02, AR1-04-07): create on show, keep a warm LRU, one scrollback number. This is the biggest memory lever in the app with many panes.
3. **Stop doing work no one reads** (AR1-04-06): no 10 s serialization of agent screens that restore discards; spread and dedupe the rest in the host.
4. **Make the renderer layer testable** (AR1-04-08), so the above can change without hand checks.

## Quick wins

AR1-04-04, AR1-04-05, AR1-04-07, AR1-04-09.
