# Direct remote access (Tailscale and your own URL)

> Status (2026-10-09): built, and works on a real tailnet (the Tailscale app's CLI: checks, publish, a phone in control, unpublish). Phases 1–3 are in: the `Transport`, `DirectListener`, access modes (the relay, `tailscale`, `url`) in one registry, the settings, the setup checklist in Settings and `cmd remote setup`, the web client in the runtime. Extends docs/13-remote-access.md, which describes the relay mode this builds on.

**Goal.** Use remote access without the hosted relay and web client: the phone talks straight to the Mac's core, over a network you control. Tailscale first, with a setup wizard; every way the Mac is reached is an **access mode**, the relay included, so other ways (your own reverse proxy URL today; Cloudflare Tunnel, ngrok, Funnel later) plug in the same way.

**Unchanged:** Noise end to end, QR pairing approved on the Mac, View/Control scopes enforced in the core, the audit log, the web client's protocol. The hosted relay stays the default for everyone else.

## Decisions

| Question | Decision |
|---|---|
| Where phones connect | Straight to the Mac. The core serves the web client and accepts device WebSockets itself; no relay, no hosted client |
| Defaults | `remote.access` is `relay` by default; Tailscale and "your own URL" are a choice in Settings → Remote Access |
| Tailscale integration | A setup wizard that detects, explains and fixes each step, and runs `tailscale serve` itself |
| Auth over Tailscale | Keep Noise + QR pairing. Tailscale's identity headers are a display hint only, never auth |
| Plugin or core | The transports in the core; access modes through a registry (below) that a future plugin host can also fill |
| Transports at once | One. Switching access pairs devices again (a different origin and route) |
| Tailscale port | A setting, `remote.tailscale.port`, default 8443 (never collides with your own Serve on 443) |
| Serve lifetime | `tailscale serve --bg`: survives core restarts and reboots; removed when remote access is turned off or switched away from Tailscale |

## What others do

| Tool | Reach | HTTPS | Auth | Takeaway |
|---|---|---|---|---|
| VibeTunnel | Serve / Funnel / ngrok / plain HTTP | Serve's cert | Password, SSH key, optional Tailscale headers | One toggle and the URL in the menu bar; it probes the CLI paths and runs `serve --bg` itself. But it runs `tailscale serve reset`, wiping the user's own Serve entries: never do that |
| OpenClaw gateway | `tailscale.mode = serve \| funnel \| off`, loopback bind | Serve's cert | Token + device identity; headers re-checked with `tailscale whois`; Funnel requires a password | Modes as config; foreground Serve, whose orphaned claims can block startup |
| code-server, `code serve-web`, OpenCode, ttyd | Bring your own (proxy, tailnet IP) | `tailscale cert` or a proxy | Password or token | "Bring your own URL"; plain `http://100.x` breaks secure-context features |
| Home Assistant | Nabu Casa, Tailscale add-on, Cloudflare Tunnel, DuckDNS | Per option | Its own login | A catalogue of access options: the adapter model |
| Moonlight / Sunshine | Tailscale IP by hand | Pinned cert | PIN pairing | Pairing that doesn't depend on the network |
| Claude Code Remote Control, VS Code Tunnels, Happy, sshx | A relay (vendor or self-hosted) | Relay TLS | Account / keys | What relay mode already is |

Sources: github.com/amantus-ai/vibetunnel (`tailscale-serve-service.ts`) · docs.openclaw.ai/gateway/tailscale · tailscale.com/docs/reference/tailscale-cli/serve · tailscale.com/kb/1153/enabling-https · tailscale.com/kb/1065/macos-variants · ipn/ipnstate/ipnstate.go · opencode.ai/docs/server

## Architecture

```
Phone ──https/wss──▶ adapter (tailscale serve: TLS on *.ts.net:8443) ──▶ 127.0.0.1:<port>  core DirectListener
                                                                          ├ GET  /…         the web client (apps/web build)
                                                                          └ WS   /r/<route> → HostChannel → policy → handlers
```

- **HTTPS is required.** The client runs Noise on WebCrypto, which only works in a secure context; `http://100.x.y.z` is not one. The listener binds to loopback only and an adapter puts TLS in front.
- **The client comes from the Mac.** docs/13's main client risk (another server serving malicious JS) goes away: the JS is served by the core it talks to.
- **The client needs no protocol change.** It dials `${relay}/r/${route}` and speaks Noise; the pairing link carries `wss://<mac>.<tailnet>.ts.net:8443` as its relay. Its identity is per origin (IndexedDB), so a phone paired with the hosted client and with the Mac directly holds two separate pairings.
- **Loopback is reachable by any local process.** That is fine: everything past the handshake needs a paired device key, as on the relay.

### Transports (core)

`RemoteService` opens channels from a `Transport`, not from `RelayLink`:

```ts
interface Transport extends EventEmitter<{ state; open: [channel, ip, hint?]; data: [channel, bytes]; close: [channel] }> {
  state: "connecting" | "online" | "error"; error: string | null;
  /** What a pairing link carries: where the device's socket goes, and where the client is. */
  endpoint(): { socket: string; client: string } | null;
  route: string | null;
  start(): void; send(channel, bytes): void; closeChannel(channel): void; close(): void;
}
```

- `RelayLink` (relay mode) implements it as is; `endpoint()` is `remote.relay` + `remote.client`.
- `DirectListener` (direct modes):
  - `node:http` + `ws` on `127.0.0.1:remote.port` (a fixed default per instance, so release and dev don't collide and a persisted Serve config stays valid).
  - Serves the web client's static build with the headers from `apps/web/public/.htaccess`, `connect-src 'self'`; every non-file path is `index.html`.
  - Upgrades `/r/<route>` only, only with `Origin` equal to the adapter's public origin; same limits as the relay (`RELAY_LIMITS`: frame size, channels, connects per minute, pings, idle close).
  - IP from `X-Forwarded-For`; `Tailscale-User-Login` kept as a hint on the session ("iPhone · lukas@").
  - Its route is a random id kept in `HostKeys` like a relay's; `endpoint()` comes from the adapter.
- Pairing (`service.ts` `pair()`) builds the link from `transport.endpoint()`.

### Access modes

Every way of reaching the Mac is an **access mode**, the hosted relay included, and every mode registers through one shared, typed interface, `AccessMode` (`packages/core/src/remote/access/mode.ts`), into a registry in the style of `WindowTypes` and `TranscriptSources` (`register` throws on duplicates, `get`, `all`, `info()` for the UI). The built-ins go through `registerBuiltinModes()` with the same `register()` a plugin host will use. `RemoteService` knows modes only by their id (`remote.access`) and has no branch for any of them:

```ts
interface AccessModeInfo {       // shared with port publishers
  id: string; title: string; icon: string; description: string;
  settings: SettingKey[];        // shown under Connection when it's picked; a change restarts it (or config(s))
  argument?: SettingKey;         // what `cmd remote access <id> VALUE` fills (url: remote.url)
  connecting: string;            // its status line while it connects
}
interface AccessMode<H> extends AccessModeInfo {   // stateless: shared freely
  missing?(s): string | null;    // why it can't start (the status error)
  messages?: { offline?(error): string; noAddress?: string };  // what pair() says when it can't make a link
  detect?(ctx): Promise<Check[]>;   // the checklist (read-only); the relay has none
  start(ctx, carried: H | null): AccessRun<H>;   // carried: what the previous run handed over on a restart
}
interface AccessRun<H> {
  transport: Transport;             // relay: RelayLink; the others: DirectListener + publish
  retry?(): Promise<void>;          // Check Again, before detect: publish again
  stop({ restart }): Promise<H | null>;  // after its transport closed: unpublish, or hand the publication to the next run
}
// ModeContext: settings (live), selected (in use and on), exec on the login PATH (loginpath.ts), the host keys, the web client's dir, log, audit.
```

- **Relay** (`access/relay.ts`): starts the `RelayLink` on `remote.relay`, reads `remote.client` when a pairing link is made; a route belongs to one relay.
- **Port publishers** sit underneath the direct modes: an `AccessAdapter` (`access/adapter.ts`) only makes a loopback port reachable and reports a URL; it never sees channels, keys or policy, so a plugin worker could run one later.

```ts
interface AccessAdapter extends AccessModeInfo {
  detect(ctx: AdapterContext): Promise<Check[]>;
  enable(ctx: AdapterContext): Promise<{ url: string }>;
  disable(ctx: AdapterContext): Promise<void>;  // only what enable() did
}
// AdapterContext: exec, settings (as they were for enable), selected, the loopback port, the route (null in checks before the first run), log.
```

- `publishedMode(adapter)` (`access/published.ts`) turns one into a mode: it runs the `DirectListener` on `remote.port`, publishes alongside it (the listener comes online with the adapter's URL), hands the publication to the next run on a restart with the same settings (the service passes what `stop({ restart: true })` returned to the next `start`), unpublishes when the mode is switched away from, turned off or one of its settings changes, and on Check Again (`retry`) publishes again on a listener that isn't online, listening again first if its port was taken. `tailscale` and `url` are adapters; `cloudflared`, `ngrok` and `funnel` would be too.
- **No fixed list.** `remote.access` is a string setting with `control: "access"`: Settings → Remote Access shows a popup of `remote.modes` (the registry's `info()`), then the chosen mode's settings and, when it has `detect`, its checklist. `cmd remote modes` lists them; `cmd remote access` and `cmd remote setup` take any id the core has. A value no mode has stays visible in the popup, marked, and is a status error naming the valid ids.

**`tailscale`:**
- CLI: `/Applications/Tailscale.app/Contents/MacOS/Tailscale` with `TAILSCALE_BE_CLI=1` (App Store and Standalone), `/usr/local/bin/tailscale`, `/opt/homebrew/bin/tailscale`, then `PATH`.
- Checks, from `tailscale status --json`:
  1. Tailscale is installed (link to the download).
  2. Logged in and connected: `BackendState == "Running"` (`NeedsLogin`: open Tailscale; `AuthURL` if present).
  3. MagicDNS on: `CurrentTailnet.MagicDNSEnabled` (link to the admin console's DNS page).
  4. HTTPS certificates on: `CertDomains` not empty (same link; says that machine and tailnet names become public in Certificate Transparency logs).
  5. Published: `serve status --json` has `TCP[port].HTTPS` and a `Web["<host>:<port>"]` handler proxying to our loopback port.
  6. Reachable: a probe of `https://<Self.DNSName without the dot>:<port>/` answers (the first certificate takes a few seconds).
- Enable: `tailscale serve --bg --yes --https=<port> http://127.0.0.1:<local port>`; "Serve is not enabled on your tailnet" on stderr maps to check 4.
- Disable: `tailscale serve --yes --https=<port> off`, only if the handler still proxies to our port. Never `serve reset`; never touch other entries. (Confirmed on a real tailnet, 2026-10-09. Not yet seen for real: what `serve --bg` prints when Serve is off for the tailnet; the adapter falls back to Tailscale's own message.)

**`url` (your own):** a public `https://` origin (Caddy, nginx, Cloudflare Tunnel, ngrok…) in front of the loopback port. Checks: HTTPS, the page loads, a WebSocket upgrade to `/r/<route>` works. `http://localhost` and `http://127.0.0.1` are accepted too (browsers treat loopback as secure), for testing on the Mac (`pnpm e2e:web:direct`). The proxy must run on the Mac itself, since the listener is loopback only; a proxy on another machine needs a tunnel to it (`ssh -R`).

**Later:** `funnel` (public: pairing already required; needs the funnel attribute, ports 443/8443/10000, not the macOS GUI variants), `cloudflared`, `ngrok`.

## Settings

| Key | |
|---|---|
| `remote.access` | An access mode's id: `relay` (default), `tailscale`, `url` (`remote.modes`) |
| `remote.port` | Local port of the listener (default per instance) |
| `remote.tailscale.port` | HTTPS port on the tailnet, default 8443 |
| `remote.url` | The public origin for `url` |
| `remote.relay`, `remote.client` | The relay mode's |

## Experience

- Settings → Remote Access: "Connect through" (Hosted relay · Tailscale · Your own URL). Choosing Tailscale shows the checklist with live state, a Fix or Open button per step, and "Check Again". When every check passes, the QR appears as it does today, and the status line names the address ("Ready on mac.tailnet.ts.net").
- States: "Tailscale isn't running", "Turn on HTTPS for your tailnet", "Publishing on your tailnet…", "Ready", "Can't reach mac.tailnet.ts.net".
- CLI: `cmd remote setup tailscale` runs the same checks (`--json`), `cmd remote access <mode> [URL]` switches, `cmd remote modes` lists the modes, `cmd remote` shows the access and address.

## Packaging

- `scripts/stage-runtime.mjs` builds `apps/web` and copies `dist` into the runtime; the core finds it next to itself.
- Dev: the core serves `apps/web/dist`; `pnpm dev` builds it when missing.

## Phases

1. `Transport` in the core; `RelayLink` behind it; pairing from `endpoint()`. No behaviour change.
2. `DirectListener`, the `url` adapter, the settings, the web build in the runtime. Tests: pairing, session, refused key, wrong Origin over a real WebSocket.
3. The `tailscale` adapter (tests against recorded `status`/`serve` JSON through a fake `exec`), the wizard in Settings, `cmd remote setup`.
4. Docs: docs/13 ("The Mac only connects out" becomes "in relay mode"), README, DEVELOPMENT.

## Pitfalls

- iOS Safari freezes WebSockets in the background (already handled by the client's reconnects); scattered reports of Safari hanging on tailnet pages.
- Don't install the App Store and Standalone Tailscale together; the LocalAPI isn't reachable from outside the App Store sandbox, so use the CLI.
- `Self.DNSName` ends with a dot.
- Serve renews its certificates; `tailscale cert` files would not, which is why the listener doesn't terminate TLS itself.
