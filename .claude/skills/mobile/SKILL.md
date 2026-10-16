---
name: mobile
description: Work on cmd's phone client (apps/web, the remote-access PWA) without a phone: drive it in an emulated iPhone with `pnpm phone` (start, ls, goto, tap, type, key, shot, eval, logs), against a seeded scenario core or the worktree's own dev core, and check it with `pnpm e2e:web`. Use when changing anything in apps/web (Now, the terminal view, compose bar, key row, pairing, settings, reconnect, push, toasts), when the user asks how something looks or behaves on the phone, sends a phone screenshot or reports a phone bug, or when changing the remote access core code the phone talks to.
---

# Mobile: the phone client

The phone client is `apps/web` (docs/13-remote-access.md, docs/38 for direct modes). docs/56-phone-development.md is the reference for both ways to run it: a real phone through `pnpm phone:serve` (the developer's, below) and the phone driver (yours). Read its "Phone driver" section once.

## The driver

```sh
export CMD_HOME=$PWD/.cmd-dev          # in your worktree, as always
pnpm phone start                       # background daemon: Vite (HMR) + a scenario core + an emulated iPhone, paired
pnpm -s phone ls                       # the terminals the phone sees: id, workspace, title, agent state, (scenario name)
pnpm -s phone goto <id|title|now>
pnpm -s phone tap <selector|text>      # a button, row or field
pnpm -s phone type <text>              # into the focused field, else the terminal on screen
pnpm -s phone key enter                # esc, tab, up, ctrl-c…
pnpm -s phone shot [--keyboard] [--theme all] [--device se|15|promax]   # prints the PNG paths; Read them
pnpm -s phone eval '<js>' | logs [--lines n] | status
pnpm phone stop                        # also stops the scenario core and its terminals
```

- **Look at every change.** Edit, `shot`, Read the PNG. Vite hot-reloads, so there is no restart between edits; shots wait for a terminal to refit. Check `--theme all`, `--device se` (the smallest screen) and `--keyboard` (iOS's shrunken visual viewport) for anything layout-related.
- **Keep the worktree's path short.** The scenario core's socket lives in `$CMD_HOME/phone/scenario-<name>/`, and macOS caps socket paths at 104 bytes: a long worktree name makes `start` time out waiting for the core (`listen EINVAL` in that folder's `logs/core.log`). `git worktree move` to a shorter name.
- **Ids change on every `start`**: the scenario core is seeded again. Take them from `ls` each time, or `goto` by title.
- `--core scenario[:<name>]` (default `default`, `tools/phone/scenarios/default.ts`): a shell, an 800-line build log, a ticker printing every second, an input probe (tells you whether input arrived as typing or a paste), a stand-in Claude asking, working and done, and htop. Add a scenario file there for a state you need again; `tools/phone/src/scenario.ts` says what one can declare.
- `--core dev`: your worktree's own core, for core changes (new methods, policy in `packages/core/src/remote/policy.ts`, events). After editing core code, `pnpm core:stop` and start again so the phone talks to the new code.
- WebKit is the default and the real check. When it can't start (some Agent Safehouse sandboxes), the driver falls back to Chromium and says so; say so too when you report, since iOS differences (keyboard, viewport, fonts) only show in WebKit, and for sure only on a real phone.
- `logs` shows the page's console and errors, then the core's log: look there first when a screen is stuck on Connecting.

## Tests

- Unit tests: `apps/web/test/*.test.ts` (connection with fake timers and a fake channel, keys, zoom, screen, pairing, `sw.js`), in `pnpm test`.
- `pnpm e2e:web` (`e2e/web.mjs`, ~25 s, WebKit; `E2E_BROWSER=chromium` when WebKit can't start): pairing, Now, terminals, the key row and compose bar reaching the PTY, Fit to This Phone, themes, toasts, reload, a second Mac. CI runs it (`web` job in `.github/workflows/build.yml`). Run it before handing back any apps/web or remote change; extend it when you add a behaviour (docs/41-testing.md: no fixed waits).
- `pnpm e2e:phone-origin`: only when changing `scripts/phone-origin/` (the proxy, `phone:core`, `phone:pair`).

## A real phone

The emulator doesn't reproduce everything: Safari's keyboard and selection, the Home Screen app, push notifications, Tailscale networking and sleep/wake. Those need the developer's iPhone: say what to check and ask them to run `pnpm phone:serve` (`--no-hmr` to see reconnects as they really happen) and, for core changes, `pnpm phone:core <your worktree>`; the phone stays paired across worktrees. Never run `phone:core` or `phone:serve` yourself unless asked: `~/.cmd-phone/home` is the developer's phone core, and Tailscale Serve is their machine's.

## Rules for apps/web

- UI from `@cmd/ui` and tokens, as on the desktop (a control the kit lacks goes into the kit, e.g. `JumpButton`); copy per the `copywriting` skill.
- The terminal shows the Mac's size scaled to the phone's width and never resizes the PTY unless the user picks Fit to This Phone (`Terminal.tsx`, `viewport.ts`, `zoom.ts`).
- What a remote device may call is `packages/core/src/remote/policy.ts`; a new method the phone needs gets an entry there (`view`, `control` or `never`; tsc refuses a method without one).
