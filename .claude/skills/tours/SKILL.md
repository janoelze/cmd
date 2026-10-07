---
name: tours
description: Record scripted demo videos ("tours") of cmd that look like a real screen recording: a TypeScript tour drives the real app with real mouse, trackpad and keyboard input, ScreenCaptureKit records the window, and the pointer is drawn in afterwards from an exact event log, so videos regenerate after UI changes. Use when the user wants a demo, marketing or product video, a screen recording, a GIF of a feature, a tour, or to re-record, fix or extend one, and when working on packages/tours.
---

# Recording tours

A tour is a short TypeScript file that says what a person does in cmd: click New…, type a command, open a file. `pnpm tour <file>` launches the built app in a throwaway fixture, records its window while the tour plays with **real input** (the pointer really moves), and renders a video with the pointer drawn in. Change the UI, run it again, get a new video. Each file in `packages/tours` says its role at the top; the research behind the approach is in `~/src/cmd-research/reports/Scripted app tour video recording.md` (outside the repo, may be gone).

## How it works

```
tours/<name>.tour.ts ─ role/name locators ─→ src/driver.ts (plans motion, scrolls targets into view)
        │                                          │ JSON lines
        │                                          ▼
src/run.ts ─ launches the built app (fixture) ─ helper/tour-helper.swift
        │                                     ├ ScreenCaptureKit: records the display showing only cmd, cropped
        │                                     │   to its window, no system cursor → raw.mov (HEVC, 2× , ~60 fps)
        │                                     ├ CGEvents: real moves, clicks, drags, trackpad scrolls, typing
        │                                     └ logs every event on the frames' clock → events.json
        ▼
src/post.ts → preview.mp4 (60 fps, our vector pointer placed per frame, a ring on clicks)
```

- **Native UI is real.** Context menus, menu-bar menus and the traffic lights are in the recording (the filter includes all of cmd's windows), nothing is faked in the DOM. `t.menuItem("Open")` clicks an item of the open native menu by title. An open context menu is **not** in the app's accessibility tree (only the menu bar is): the helper finds it as one of cmd's windows above layer 0 in ScreenCaptureKit's list, hit-tests a point in it (`AXUIElementCopyElementAtPosition`) and climbs to the `AXMenu`, whose children are the items with frames.
- **The helper keeps the clock.** Event times are `mach_absolute_time` ns, the clock of ScreenCaptureKit's frames. Node's `process.hrtime` is a different clock (it counts sleep): never timestamp with it, ask the helper (`helper.now()`).
- **The pointer is data.** `raw.mov` has no cursor; `events.json` says exactly where it was. Re-render the pointer (size, smoothing, style) without re-recording.
- **Motion** (`src/motion.ts`): one gently bent Bezier per move, Fitts' law duration ×1.3 (±10%, at least 160 ms), speed peaking at ~36–44% then tapering (a symmetric minimum-jerk peak at 50% looked mechanical), and moves over 250 pt land a little short or long and correct (Meyer's submovements). No jitter. **Scroll** (`src/scroll.ts`): a finger phase, then Apple-like momentum, sized to the exact distance. **Typing** (`src/typing.ts`): log-normal gaps, `TYPING.terminal` (~70 ms) or `TYPING.field` (~100 ms). Seeded: the same tour and `--seed` move the same way.

## One-time setup (per Mac)

Recording and posting input need macOS permissions and, in Agent Safehouse, sandbox rules. Check with the probe; every line must say `ok`:

```sh
swiftc -O packages/tours/helper/probe.swift -o $TMPDIR/probe && $TMPDIR/probe
```

If it fails, the user (not you: it runs outside the sandbox) runs `packages/tours/scripts/safehouse-screen.sh`:

1. `check`: asks macOS for the permissions. Grant **cmd** (the app the session runs in) Screen Recording and Accessibility in System Settings, then quit and reopen cmd.
2. `learn`: runs the probe in the sandbox and turns its denials into `~/.config/safehouse/screen.sb` (so far: `replayd`, `coremedia.videoencoder`, `PowerManagement.control`, per-pid `axserver`). Read what it adds before installing.
3. `install`: adds an opt-in line to `safe()` in `~/.zshrc`. Then a session started as `SAFEHOUSE_SCREEN=1 claude` gets the access; others don't. (A session resumed by cmd after a restart reruns the stored command without it: start it by hand, `SAFEHOUSE_SCREEN=1 claude --resume`.)

The access is real: such a session can see the screen and move the mouse. Use it for tour work only. `uninstall` removes the line and the profile.

Diagnose without taking over the user's mouse where you can: pop a native menu from code (`Menu.buildFromTemplate(…).popup({ window, x, y })` via `app.evaluate`) and ask the helper what it sees, as `experiments/axdump.mjs` does. Only full tour runs need the user's hands off.

| Probe line fails | Cause |
|---|---|
| accessibility / screen recording | cmd lacks the permission: `check`, grant, reopen cmd |
| accessibility read `-25204`, screencapturekit "no answer", video encoding `-12903` | sandbox rules missing or the session wasn't started with `SAFEHOUSE_SCREEN=1` |
| everything passes outside the sandbox, fails inside | `learn` again (a new probe check needs new rules), then restart the session |

## Writing a tour

```ts
// tours/<name>.tour.ts
import type { Tour } from "../src/driver.ts";
import type { TourMeta } from "../src/run.ts";
import { TYPING } from "../src/typing.ts";

export const meta: TourMeta = {
  size: [1280, 800],                       // window content size, points
  files: { "notes.md": "# Notes\n", "src/": "" },   // the fixture home ("…/" = folder)
  settings: {},                            // settings.json for the fixture
  setup: async (t) => { await t.command("file.newTerminal"); },  // unrecorded
};

export default async function (t: Tour) {
  const p = t.page;
  await t.click(p.getByRole("button", { name: "New…" }));
  await t.type("terminal", TYPING.field);
  await t.press("Return");
  await t.type("ls\n");                                   // into whatever has focus
  await t.click(p.getByRole("tree", { name: "Files" }).getByRole("treeitem", { name: "notes.md" }), { clicks: 2 });
  await t.pause(1200);                                    // let the viewer read
}
```

The `Tour` API (`src/driver.ts`): `click(target, { button, clicks })`, `hover(target)`, `drag(from, to)`, `type(text, profile)`, `press(key, ...mods)` (`"Return"`, `"Escape"`, arrows, letters; mods `cmd`, `shift`, `alt`, `ctrl`), `scroll(container, { by } | { to })`, `reveal(target)`, `command(id)` (an app command from `shared/commands.ts`, no pointer: for setup and cuts), `pause(ms)`; `t.page` and `t.app` are Playwright's.

- **Move the pointer off buttons you're done with** (`t.away()`): a pointer resting on a button keeps its hover state and tooltip up, e.g. at the end of a shot.
- **Wait for the state you mean**: `getByRole("option", { name: "Canvas", exact: true, selected: true }).waitFor()` before pressing Return in the palette; a new Files window opens in the selected terminal's folder (`cd` there first).
- **Find things by role and name**, never CSS classes: windows are `group "<name>, <kind>, <place>"`, the Navigator's sections are `tree "Windows"` with `treeitem`s, the palette is a `combobox` over `option`s, Files is `tree "Files"`, Settings rows name their controls. If something can't be found by role and name, fix its accessibility in the app (and `pnpm e2e:a11y` keeps it fixed), don't reach for a class.
- **Don't script scrolling to reach things.** `click`/`hover` scroll the target into view themselves, visibly. Write `scroll` only when scrolling is the point of the shot.
- **Wait on the app, pace for people.** Wait for state with locators (`.waitFor()`); use `pause` only so viewers can follow (0.8–1.5 s on a result).
- **Setup is unrecorded.** Put what the video shouldn't show (opening windows, getting into a state) in `meta.setup`.
- **Tours that need a model** (a Magic widget build) set `meta.ai: true`. The runner takes the person's key from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`/`OPENAI_KEY`) or `~/.secrets`, writes it only into the fixture's `secrets.json` (0600), picks the provider, and deletes the file after the run. Never print or log a key. Such runs cost a little and build something slightly different each time: say so when asking to run one. A Magic build starts from New…: type the prompt, then click the last option, `Make “<prompt>” with Magic`.
- Never put the user's real files, sessions, names or tokens in a tour: the fixture (`src/fixture.ts`) gives a demo prompt (`~ ❯`), an empty transcripts folder and its own home.

## Running one

The app runs from its build, so build first after app changes:

```sh
pnpm build
pnpm tour packages/tours/tours/first.tour.ts            # → .cmd-dev/tours/out/first/
pnpm tour packages/tours/tours/first.tour.ts --seed 2 --out /some/dir
```

**Tell the user before every run** and wait for their go: for the length of the tour their real mouse and keyboard are taken over, a cmd dev window opens on their screen, and they must not touch anything. Moving the mouse stops the run ("the mouse moved…"); a key press would go into the tour. A run that fails mid-way still records up to there.

Output in the run's folder: `raw.mov` (no cursor), `events.json`, `meta.json` (window rect on screen, scale, `t0`/`t1`), `preview.mp4`. Re-render only the pointer: `node packages/tours/src/post.ts <run dir>`.

**Check your work by looking**, not by the exit code: pull frames at the moments that matter and read them.

```sh
ffmpeg -v error -ss 8.7 -i preview.mp4 -frames:v 1 -vf scale=1100:-1 frame.png
node -e 'const e=require("./events.json"),m=require("./meta.json");for(const x of e.filter(x=>x.type==="down"))console.log(((x.t-m.t0)/1e9).toFixed(2),x.x,x.y)'   # click times
```

Verify the pointer's tip sits on what it clicks, text is crisp, nothing personal is visible, and the shot reads.

When a run stops mid-way, the error says where (`no open menu item "Open"`, a locator timeout, `the mouse moved (it's at …, the tour left it at …)`). The recording up to there is in the run folder. Fix, then ask the user before running again.

## Working on the helper

- Posted events land a few ms after `post()`: don't compare the pointer to the last posted point mid-path (the interference check runs once per command and waits up to 60 ms for the pointer to arrive).
- A new kind of system call can need a new sandbox rule even when the permissions are fine (VideoToolbox failed with `-12903` until `coremedia.videoencoder` was allowed). Add a check for it to `probe.swift` first, so `learn` sees the denial, then the user reruns `learn` and restarts the session.
- Repo TypeScript rules apply (type stripping): no parameter properties, `import type`, `.ts` extensions; the repo has `noUncheckedIndexedAccess`. Scripts that import Playwright must live in the repo (e.g. `experiments/`), not in `$TMPDIR`, or the import doesn't resolve.

## Files

- `packages/tours/src/`: `driver.ts` (Tour API), `run.ts` (runner, `pnpm tour`), `post.ts` (pointer render), `helper.ts` (Node side of the helper, rebuilds it when the Swift source is newer), `fixture.ts`, `motion.ts`, `scroll.ts`, `typing.ts`, `random.ts`.
- `packages/tours/helper/`: `tour-helper.swift` (recording, input, log), `probe.swift` (permissions check), `still.swift` (one-off stills).
- `packages/tours/tours/`: the tours. `experiments/`: the experiments that settled the approach.
- `packages/tours/scripts/safehouse-screen.sh`: the sandbox setup above.
- Tests: `packages/tours/test/` (the planners; anything that needs real input or recording is checked by running a tour and looking at frames).

## Not done yet

- Post: spring smoothing of the pointer, zoom on clicks, the window's shadow and a background (own renderer, or Cap's `cap export` / Remotion: mind Remotion's company license).
- Pointer shape (I-beam over text, resize over edges) isn't logged yet; the arrow is always drawn.
- Menu-bar menus: the items are found the same way once a menu is open, but opening one (clicking its title in the menu bar) isn't wrapped yet; the menu bar strip itself isn't in the recording (it's the system's, not cmd's).
- `shortPath` in the app treats only `/Users/<name>` as home, so the fixture's paths show in full instead of `~`.
- `reveal` stops a target just inside the edge; viewers would rather see it near the middle.
