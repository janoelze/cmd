# Plugins, routines, monitors and system tasks

This is a proposal built from the patterns in [04-prior-art.md](04-prior-art.md). It is a starting point, not a final spec.

## What exists locally to migrate
- **`~/src/private-vpn`**: WireGuard scripts.
  - `up.sh` turns IPv6 off on every network service, runs `sudo wg-quick up vpn.conf`, then shows `wg show` and the public IP.
  - `down.sh` reverses this.
  - `status.sh` SSHes into the VPN server for uptime, load and peer count.
  - `add-key.sh` and `sync-keys.sh` manage peer keys.
  - **`status.sh` has a root password hardcoded and uses `sshpass`.** A routine system should replace this with keychain-backed secrets or SSH keys.
- **`~/.ssh/config`**: about 6 `Host` entries. Saved SSH connections should **read `~/.ssh/config` as the source of truth** rather than keep a second list, and add only metadata on top: color, group, a "connect in canvas region" action, a jump-host picker.
- **Tunnelblick** is installed. Its AppleScript interface (`connect "name"`, `get state of configurations`) is an easy monitor and routine target.
- `scutil --nc list` lists macOS VPN services (none at the moment).

## Concepts
Use one manifest-driven plugin model. Each plugin is a folder or an npm package, written in TypeScript, and contributes some of the following:

| Contribution | Description | Example |
|---|---|---|
| **routine** | A named, parameterized action. Runs a script in a terminal tab (visible, interactive, can sudo) or in the background (output captured). | `vpn.up`, `vpn.down`, `ssh.connect`, `brew.upgrade` |
| **monitor** | A periodic or event-driven probe that returns typed state, shown as a status-bar item, a sidebar badge or a canvas widget. | VPN connected? (`wg show`, `ifconfig utun*`, public IP), disk free, Docker up, CI status |
| **sidebar section** | A list provider with items and actions. | Agents, Terminals, SSH hosts, Routines |
| **agent adapter** | Detection signals, a state mapping, a transcript parser and a resume command for one agent CLI. | `claude`, `codex`; later `gemini`, `opencode` |
| **command** | An entry in the command palette, plus an optional keybinding. | "Search sessions", "New terminal in project…" |
| **canvas node type** | A custom node on the infinite canvas. | Terminal, Markdown note, web view, monitor graph, diff |
| **terminal hooks** | Handlers for OSC sequences, output matchers and title changes. | Detect `ssh` sessions, notification codes |

Agent support is itself written as plugins (Claude and Codex adapters). This keeps the core small and makes adding an agent a matter of writing a plugin.

### Example manifest
```ts
// plugins/vpn-wireguard/plugin.ts
export default definePlugin({
  id: "vpn-wireguard",
  settings: {
    dir: path({ default: "~/src/private-vpn" }),
    exitIp: string(),                      // the VPN server's public IP
  },
  routines: {
    up:   { title: "VPN up",   run: ({ term, settings }) => term.run(`${settings.dir}/up.sh`) },   // visible tab, sudo prompt works
    down: { title: "VPN down", run: ({ term, settings }) => term.run(`${settings.dir}/down.sh`) },
  },
  monitors: {
    status: {
      every: "15s",
      // `wg show` needs root; comparing the public exit IP needs no privileges
      probe: async ({ exec, settings }) => {
        const r = await exec("curl", ["-4", "-s", "--max-time", "3", "ifconfig.me"], { allowFail: true });
        return { state: r.stdout.trim() === settings.exitIp ? "on" : "off", ip: r.stdout.trim() };
      },
      render: (s) => statusItem({ icon: "shield", tone: s.state === "on" ? "ok" : "muted" }),
    },
  },
});
```

UI is returned as **data** (`statusItem`, `list`, `form`) that the host renders, as Raycast does. Plugins never touch the DOM directly. This gives:
- full theming in one place
- plugins that are testable as pure functions
- plugins that can run outside the UI process

Plugins that want their own UI can contribute a **canvas node / panel** rendered in an isolated iframe or webview.

## Runtime and isolation
- Plugins run in the **core process**, or in one `utilityProcess` or worker per plugin, with a capability-scoped API: `exec`, `term`, `fs` (scoped), `secrets`, `notify`, `state` (a per-plugin key-value store backed by SQLite).
- They talk to the core over typed RPC, with one schema shared by the UI and the plugins (e.g. zod/valibot + a small RPC layer, or tRPC over MessagePort).
- **Hot reload:** watch the plugin folder and restart that one plugin's worker. Terminals are owned by the core, not by plugins, so they are unaffected.
- The **same API is reachable from a CLI over a Unix socket** (`cmd run vpn.up`, `cmd notify "done"`, `cmd open --cwd .`), as cmux, Wave and Kitty do. Routines then become scriptable from any shell, and agents can drive the app.

## sudo and privileged actions
`wg-quick` and `networksetup` need root. In order of simplicity:
1. Run the routine **in a visible terminal**, so the sudo prompt just works. This is the default and the most honest option.
2. Add a `sudoers.d` rule (NOPASSWD for those exact commands) so routines can run in the background. It is documented per plugin and the user installs it.
3. Later: a small privileged helper (`SMAppService` daemon). Overkill for personal use.

## Secrets
Use the macOS Keychain, via `security` CLI or a native module such as `keytar` (keytar is archived, so a small Swift helper or `@napi-rs/keyring` is better). 1Password CLI (`op read`) can be an optional provider; the sandbox already allows the 1password capability. Plugin settings refer to secrets by reference (`secret("vpn/root")`), never in plain text.

## SSH connections
- Parse `~/.ssh/config`, including `Include` and wildcards (e.g. the `ssh-config` npm package), to build the host list.
- Run `ssh <alias>` in a new terminal or canvas node. Detect the SSH session in a pane through the foreground process, as with agents, and show "connected to X" on the tab.
- Optional actions: `ControlMaster` for fast reconnects, port forwards declared as a monitor plus a routine, and `sshfs` or `scp` routines.

## Testing plugins
- `probe` and `run` take an injected `exec`/`term`, so unit tests use fake results (Vitest).
- An integration harness starts the core headlessly with a fake PTY.
- The CLI over the socket allows end-to-end scripts without the UI.
