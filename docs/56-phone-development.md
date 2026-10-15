# Phone development

**Status:** built (2026-10-15): `pnpm phone:serve`, `phone:core`, `phone:use` and `phone:pair` in `scripts/phone-origin/`, unit tests in `test/phone-origin.test.ts`, `pnpm e2e:phone-origin`; not yet tried on a real phone. The phone driver for agents (`pnpm phone`, `tools/phone/`) uses the same proxy.

Working on the web client (`apps/web`, docs/13, docs/38) on a real phone used to mean re-pairing all the time and no hot reload: the core serves a built `dist`, and a phone keeps its pairings per origin (IndexedDB), so every new address was a new, unpaired device. This sets up **one fixed HTTPS origin** for the phone, served by Vite with hot reload, that reaches both the installed app's core (your real sessions) and a dev core. You pair once with the installed app and once with the phone's dev core, which keeps one state dir whatever worktree it runs ("The phone's dev core"), and stay paired.

## Topology

```
phone (Safari / Home Screen app)
  │  https://<mac>.<tailnet>.ts.net:5443          one origin, its pairings stay put
  ▼
Tailscale Serve (HTTPS with the tailnet's certificate; sets X-Forwarded-For, Tailscale-User-Login)
  │  http://127.0.0.1:5190
  ▼
Vite (apps/web from source, HMR over wss://…:5443)  ── scripts/phone-origin/serve.ts
  │  WebSocket upgrades only:
  ├─ /c/release/r/<route> ──▶ 127.0.0.1:47391/r/<route>   the installed cmd's direct listener
  └─ /c/dev/r/<route>     ──▶ 127.0.0.1:<port>/r/<route>  the phone's dev core (~/.cmd-phone/home), from the checkout `pnpm phone:core` names
```

The page and its code come from Vite; the core's own listener serves nothing to the phone but the socket. The bytes on the socket are Noise (docs/13): the proxy sees only ciphertext.

## Setup, once

1. Tailscale on the Mac and the phone, both in the same tailnet, with MagicDNS and HTTPS certificates turned on (the same checklist as Settings → Remote Access → Tailscale).
2. The installed cmd with remote access on through **Tailscale** or **Your own URL** (Settings → Remote Access). Only then does it run the local listener `/c/release` needs; see "What the release app needs" below.
3. `pnpm install` in the checkout you run this from, and in each worktree whose code the phone's dev core should run.

## Daily use

```sh
pnpm phone:serve                 # Vite + Tailscale Serve on :5443; prints the phone's URL. Ctrl-C to stop
pnpm phone:core                  # the phone's dev core, from this checkout's code; /c/dev points at it
pnpm phone:pair dev              # once: QR + link for the phone's dev core; approve on the Mac (here or in cmd's sheet)
pnpm phone:pair release          # once: the same for the installed cmd
# later, another worktree: no pairing
pnpm phone:core ~/src/cmd-other  # the same core restarts on that worktree's code; reload the page on the phone
```

- `phone:serve` keeps Vite on `127.0.0.1:5190` (`--port`), publishes it with `tailscale serve --bg --https=5443 http://127.0.0.1:5190` (`--https-port`), allows the `ts.net` name as a Vite host and points HMR at `wss://…:5443`. It only adds or removes its own port's entry, like the core's Tailscale adapter, and Ctrl-C takes it off again when this run added it (an entry that was already there stays). Without Tailscale (not installed, not connected, or a sandbox that can't run it) it prints the exact `tailscale serve` command and still serves on localhost; `--no-tailscale` skips it.
- `phone:core [checkout]` (default: this checkout) runs the phone's dev core from that checkout's code, with `CMD_HOME=~/.cmd-phone/home` and none of a pane's variables. When it's already running that checkout's code it's left as it is; when it runs another checkout's (`core.hello`'s `root`), it's stopped first, terminals included (as `pnpm core:stop --terminals`), then started from the new one. It's made reachable through the proxy (with remote access off or on the relay it's switched to Your own URL on its own loopback port, `http://127.0.0.1:<port>`, which is all the proxy needs) and `/c/dev` points at it. It prints which checkout it runs now.
- `phone:use [worktree | CMD_HOME | phone]` points `/c/dev` at another dev core for a while, e.g. a worktree's own `.cmd-dev`, the core that worktree's `pnpm dev` app shows, so phone and Mac show the same terminals. That core has its own host key, so it pairs on its own (`phone:pair dev`, once per such core). A running one is made reachable as above (never the release app). `phone:use phone` or `phone:core` points back. It writes `~/.cmd-phone/target.json`; the proxy reads it on every connection, so switching never restarts Vite. The port is the core's own `defaultDirectPort()` for that state dir (or its `remote.port` setting), the socket the protocol's `coreSocketPathOf()`. With no argument it says what `/c/dev` reaches; `phone:serve`'s banner says the same.
- `phone:pair` asks the core for a pairing link the way `cmd remote pair` does (`remote.pair`), moves its client to the phone origin and its socket to `wss://<phone origin>/c/<target>` (route, host key and one-time key unchanged), and prints a QR code and the link. It asks for view only unless you pass `--control`; at approval you pick either way. `--json` prints the link and exits (scripts). A dev core is made reachable first, as `phone:core` does; when `/c/dev` points somewhere other than the phone's dev core, it notes that the pairing holds for that core only. The release app's settings are never changed.
- On the phone: open the URL once, Add to Home Screen if you want the app, then scan each `phone:pair` QR from the app's Scan Code (or open the link). Both pairings (release, and the phone's dev core) live in the one origin's IndexedDB, side by side; the app's Mac switcher picks between them.

## The two targets

| | `/c/release` | `/c/dev` |
|---|---|---|
| Core | the installed cmd (`127.0.0.1:47391`) | the phone's dev core, running a checkout of your choice (`phone:core`), or another dev core for a while (`phone:use`) |
| Data | your real terminals and agents | the phone home's own (`~/.cmd-phone/home`) |
| Core code | the released version | your branch |
| Use it for | UI-only work: layout, touch, the terminal view, copy | anything that needs core changes: new methods, policy, events |

## The phone's dev core

Each worktree's core is its own instance with its own `.cmd-dev`, so pairing the phone with those would mean pairing again for every worktree, and losing the pairing when the worktree is removed. The phone gets a dev core of its own instead, in one fixed state dir, `~/.cmd-phone/home`: its host key, routes and paired devices stay there whichever checkout's code it runs.

- Pair once with it (`pnpm phone:pair dev`).
- Switching worktrees is `pnpm phone:core <worktree>`, then reload the page on the phone. No pairing.
- One runs at a time. When it switches checkouts, the terminals in the phone home end: they belong to that home, and a PTY host from a removed checkout couldn't start shells anyway. Its settings, workspaces and history stay.
- The main checkout's dev instance and every worktree's own `.cmd-dev` are untouched: their cores, apps and pairings are their own.
- The phone home's data is written by whatever checkout last ran it. A branch that migrates the database ahead of another can make an older checkout's core refuse it ("data from a newer cmd"); start over with `CMD_HOME=~/.cmd-phone/home pnpm core:stop --terminals` and deleting `~/.cmd-phone/home` (the phone pairs again).

## Pairing the release app from the dev origin: limitations

- **The release core is behind your UI code.** It only knows the methods and remote policy (`remote/policy.ts`) of the installed version. A new core feature (a new session RPC, an event, a policy entry) needs `/c/dev`. The dev UI must ask `has(method)` before calling anything newer than the release, as every client meeting an older core does. A `PROTOCOL` bump on a branch can make the dev UI and the release core refuse each other until the next release. Use `/c/release` for UI-only work.
- **Real data, untested code.** With control scope a bug in the dev UI acts on real terminals: stray keys into a live Claude session, resizing real PTYs (the Mac's terminal takes the phone's size while it shows it), `pane.kill`. View only avoids that: `phone:pair` asks for view only by default, and approval (in the terminal or in cmd's sheet) offers View only or Control. Change it later in Settings → Remote Access or with `cmd remote scope DEVICE view`.
- **It's a second device.** The phone origin is its own origin, so it's its own entry in the release app's device list, next to the phone's normal pairing. Keep notifications off on the dev origin, or every notification arrives twice. Pairings expire after `remote.deviceExpiryDays` (30 by default) unseen.
- **`phone:pair` only rewrites the link.** Nothing changes in the release app: no setting, no access mode, no Serve entry. It does make a new pairing link, which (as with `cmd remote pair`) replaces one the app may be showing at that moment.
- **What the release app needs** (see the next section): remote access on, through Tailscale or Your own URL. On the hosted relay (the default) it has no local listener, and `phone:pair release` says so instead of changing anything.
- **Who's connecting and rate limits still work** through the extra hop (next section but one).

## What the release app needs: the direct listener

A core's direct listener (`remote/direct.ts`, 47391 for release, 47392 for cmd dev, a hashed port per CMD_HOME) does **not** run on its own. It's part of a direct access mode: `publishedMode()` (`remote/access/published.ts`) creates the `DirectListener` in `start()`, which `RemoteService` calls only while `remote.enabled` is on and `remote.access` is `tailscale` or `url`. With the relay (the default), or with remote access off, nothing listens. And even while it listens it refuses every upgrade until its adapter has reported a public origin (Tailscale Serve published, or a valid `remote.url`), because upgrades must carry that origin as `Origin`.

So for `/c/release` the installed app needs Settings → Remote Access on, connected through Tailscale (its own Serve entry, by default `https://<mac>.<tailnet>.ts.net:8443`, next to this one on 5443) or Your own URL. Switching from the relay means the phone's existing relay pairing has to pair again, since each mode has its own route.

**Possible change** (in the core, not made; for the developer to decide): run the loopback listener whenever remote access is on, whatever the mode, with its own route, and let it accept a configured list of extra origins for loopback proxies (a `remote.localOrigins` setting, empty by default). Then `/c/release` works with a release on the relay, without switching modes or re-pairing the everyday phone, and the proxy wouldn't need to restate the core's origin.

## How the proxy keeps the listener's checks

`scripts/phone-origin/proxy.ts`, per upgrade:

- **Origin.** The listener takes upgrades only with its own public origin. The proxy takes them only from its own page: the `Host` must be one it serves (`127.0.0.1:<vite port>`, `localhost:<vite port>`, the tailnet name with `:5443`, bare on 443), and the `Origin` must be on that host. Matching alone wouldn't do: a site rebound to 127.0.0.1 (DNS rebinding) sends a `Host` and `Origin` that agree, and since the proxy restates the core's origin, it would get past the listener's own check. Then it sends the core's origin, read from `remote.status` (its `address`) over the core's socket on every connection.
- **X-Forwarded-For.** The listener rate-limits connections and lists sessions by the rightmost entry, the address its one trusted proxy saw. Tailscale Serve, in front of Vite, appends the phone's tailnet address, so the proxy passes the header on untouched and that address stays rightmost. Without a proxy in front (localhost), it adds the address it saw, which is what the listener would have used.
- **Tailscale-User-Login.** Serve sets it and strips any a client sends; passed on as is, so a core in Tailscale mode still shows who's connecting (its `identify` hook). A core in Your own URL mode has no `identify` and shows none, as without the proxy.
- `Host` is set to the listener's, `X-Forwarded-Host` keeps the phone origin's, and only `/c/<target>/r/<route>` is forwarded (anything else gets 404; an unreachable core 502, a core without remote access 503, each with a line in the `phone:serve` terminal).

## Phone driver: the agents' side

Agents can't hold a phone, so `pnpm phone` (`tools/phone/`) drives the same client in an emulated iPhone from short commands, the way `pnpm workbench` drives the desktop UI. It reaches its core the way the phone origin does: `tools/phone/src/daemon.ts` runs Vite for `apps/web` with `phoneProxy` mounted (its `info` points `/c/dev` at the driver's core and refuses `/c/release`), makes the core reachable with `reachable()` (Your own URL on its loopback port) and pairs through a link moved to Vite by `rewriteLink()`. So the client stays on Vite with hot reload, and no core gets another access mode than `phone:use` would give it.

```sh
pnpm phone start [--core scenario[:<name>]|dev] [--browser webkit|chromium] [--device se|15|promax]
pnpm phone shot [--device se] [--theme light|dark|all] [--keyboard] [--out dir]   # .cmd-dev/shots/phone-<screen>-<device>-<theme>.png
pnpm phone ls | goto <id|title|now> | tap <selector|text> | type <text> | key <enter|esc|ctrl-c…>
pnpm phone eval '<js>' | logs [--lines n] | status | stop
```

- `start` runs it in the background with its own control port; the other commands go to it. The browser is WebKit, or Chromium when WebKit can't start (as in the Agent Safehouse sandbox), with a persistent profile in `$CMD_HOME/phone/profile/<browser>` (else `.cmd-dev/phone`), so pairings survive `stop` and `start`. The Vite port is kept in `ports.json`, since the origin holds the pairings.
- **Pairing.** The daemon reads the profile's pairings (IndexedDB, keyed by host key) on a page of the origin that doesn't run the app, and opens the one whose device the core knows (`remote.devices`); none: it pairs, approving over the core's socket, and logs `pairing: paired this browser now`; later starts log `pairing: kept, no pairing ran`. It drops pairings for other addresses, and a core's old one when the core comes back under a new host key (`pairings.json`), so the profile holds one pairing per core however often it restarts (10 restarts: still 1); a scenario core also revokes devices it paired before.
- **`--core scenario:<name>`** (the default: `default`): a throwaway core in `$CMD_HOME/phone/scenario-<name>`, its host key and paired devices kept in that folder (stable across starts), seeded on every start from `tools/phone/scenarios/<name>.ts`: workspaces with terminals, each a command, folder and environment, and for an agent the hook events it would send (`tools/phone/src/scenario.ts`). `default` has a shell, a long build log, htop and the README shots' stand-in Claude (`scripts/readme-shots/fake-claude.mjs`, detected as Claude) asking, working and done. `stop` stops it and its terminals.
- **`--core dev`**: the worktree's own dev core (`$CMD_HOME`, else the worktree's `.cmd-dev`), for a branch's core changes. A running one is used as it is and never stopped; none running, it starts one as `pnpm core` would and leaves it running. Never the phone's dev core in `~/.cmd-phone/home` (`phone:core`'s, the developer's; agents' sandboxes can't write there either) nor the main checkout's dev instance: it refuses both. It doesn't change `/c/dev` for `phone:serve`.
- `--keyboard` shrinks the visual viewport as iOS does when the keyboard opens (`apps/web/src/main.tsx` sizes the app to it) and draws a keyboard there. Shots wait for a terminal to refit. `e2e/web.mjs` shares Vite and core helpers with it (`tools/phone/src/harness.ts`).

## Tests

- `test/phone-origin.test.ts`: the rewritten link decodes with remote-crypto's parser (socket and client changed, route, host key and PSK intact); `/c/<target>` paths; ports and sockets from `defaultDirectPort()` and `coreSocketPathOf()`; `/c/dev` on the phone's dev core unless `phone:use` says otherwise; and the proxy against stand-in listeners, with the target file changed mid-test and a DNS-rebinding-style request refused.
- `pnpm e2e:phone-origin` (`e2e/phone-origin.mjs`): `phone:serve --no-tailscale` and the phone's dev core started by `phone:core` from this checkout, in a throwaway `CMD_PHONE_DIR`. An emulated iPhone in Chromium opens `phone:pair dev --json`'s link at `http://127.0.0.1:<port>` (localhost is a secure context), pairs through the proxy, the Mac approves over the core's socket, and a reload stays paired. Then `phone:core` runs it from another checkout (a throwaway git worktree of HEAD borrowing this one's `node_modules`): the core restarts on that code (`core.hello`'s root), and a reload is connected again with no pairing.
