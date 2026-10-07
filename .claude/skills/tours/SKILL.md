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
src/post.ts → tour.mp4: wallpaper → the window's real shadow → the recording masked to the
              window's real shape → the real cursor shapes, per frame from the log → 60 fps H.264
```

- **Native UI is real.** Context menus, menu-bar menus and the traffic lights are in the recording (the filter includes all of cmd's windows), nothing is faked in the DOM. `t.menuItem("Open")` clicks an item of the open native menu by title. An open context menu is **not** in the app's accessibility tree (only the menu bar is): the helper finds it as one of cmd's windows above layer 0 in ScreenCaptureKit's list, hit-tests a point in it (`AXUIElementCopyElementAtPosition`) and climbs to the `AXMenu`, whose children are the items with frames.
- **The helper keeps the clock.** Event times are `mach_absolute_time` ns, the clock of ScreenCaptureKit's frames. Node's `process.hrtime` is a different clock (it counts sleep): never timestamp with it, ask the helper (`helper.now()`).
- **The pointer is data.** `raw.mov` has no cursor; `events.json` says exactly where it was. Re-render the pointer (size, smoothing, style) without re-recording.
- **High realism is the goal: everything shown is what macOS showed.** The cursor is the real system cursor: while recording, the helper polls `NSCursor.currentSystem` every 30 ms, saves each new shape once (`cursors/cursor-<id>.png`, its largest image, up to 10×, with the hotspot) and logs changes; post draws the logged shape (arrow, I-beam over text and terminals, open/closed hand on title bars and drags, copy-arrow during file drags, resize arrows). Before recording, `window-still` takes the window alone with macOS's real shadow and alpha (`window.png`): its opaque pixels are the window's exact shape (rounded corners, the light edge), the rest is the shadow; post masks the recording with it and lays it on a wallpaper. Click rings are off by default (real recordings have none; `--clicks`). No path smoothing: the driver's motion is already human. Waiting (an agent working, a build) can play faster: `meta.post: { idle: 4 }` (or `--idle 4`) speeds up input-free stretches over 3 s, keeping ~0.9 s real-time at each end, so output visibly streams in fast.
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

`TOUR_DEBUG=1 pnpm tour …` logs every hover and reveal (and each scroll it plans): the first thing to read when a run stops with "still off screen after revealing it" (the driver refuses to move the pointer off the window, where macOS would clamp it and the interference check would fire). Diagnose without taking over the user's mouse where you can: pop a native menu from code (`Menu.buildFromTemplate(…).popup({ window, x, y })` via `app.evaluate`) and ask the helper what it sees, as `experiments/axdump.mjs` does. Only full tour runs need the user's hands off.

| Probe line fails | Cause |
|---|---|
| accessibility / screen recording | cmd lacks the permission: `check`, grant, reopen cmd |
| accessibility read `-25204`, screencapturekit "no answer", video encoding `-12903` | sandbox rules missing or the session wasn't started with `SAFEHOUSE_SCREEN=1` |
| everything passes outside the sandbox, fails inside | `learn` again (a new probe check needs new rules), then restart the session |

## Kai, the person in the videos

Every tour runs on Kai's Mac (`src/persona.ts`, applied unless `meta.persona: "none"`): `kai@kai-mbp` in the prompt, `~/src/atlas` (a trip-planning web app, the main work, with Kai's git history), `~/notes` (standup, todo), four past agent sessions in Recent, and `~/src/fizzbuzz` "for Thursday's interview". The videos are a series about Kai's ordinary day, so they can pick up from each other. Keep the humour to a nod (one fizzbuzz moment, not a theme): the point is showing what cmd can do on real-looking work. Extend Kai's world in `persona.ts` rather than per tour, so every video agrees on it.

## Writing a tour

```ts
// tours/<name>.tour.ts
import type { Tour } from "../src/driver.ts";
import type { TourMeta } from "../src/run.ts";
import { TYPING } from "../src/typing.ts";

export const meta: TourMeta = {
  size: [1280, 800],                       // window content size, points
  files: { "scratch.md": "# Scratch\n" },          // extra files in Kai's home ("…/" = folder)
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

The `Tour` API (`src/driver.ts`): `click(target, { button, clicks })`, `hover(target)`, `drag(from, to)`, `dragBy(from, dx, dy)`, `swipe(px)`, `pan(dx, dy)`, `zoom(px, at?)`, `menuItem(title)`, `waitForText(terminalWindow, re)`, `away()`, `scrollToStart(container)` (setup), `windowBox()`, `type(text, profile)`, `press(key, ...mods)` (`"Return"`, `"Escape"`, arrows, letters; mods `cmd`, `shift`, `alt`, `ctrl`), `scroll(container, { by } | { to })`, `reveal(target)`, `command(id)` (an app command from `shared/commands.ts`, no pointer: for setup and cuts), `pause(ms)`; `t.page` and `t.app` are Playwright's.

- **Move the pointer off buttons you're done with** (`t.away()`): a pointer resting on a button keeps its hover state and tooltip up, e.g. at the end of a shot.
- **Labels differ between pickers**: the command palette says "New Claude Session", the New… picker drops the "New " ("Claude Session", "Terminal", "Files", widgets by title, e.g. "Live Diff"). Check the label (`shared/commands.ts`, `renderer/src/newItems.ts`) before waiting for an option.
- **Wait for the state you mean**: `getByRole("option", { name: "Canvas", exact: true, selected: true }).waitFor()` before pressing Return in the palette; a new Files window opens in the selected terminal's folder (`cd` there first).
- **Strip view is the showpiece** (windows side by side, swiped through): `t.swipe(px)` is a sideways trackpad swipe where the pointer is (Chromium scrolls the strip with real momentum); `click`/`hover` on a window off to the side swipe there first (`reveal` handles sideways scroll containers and centres the window); the page dots are `group "Windows"` with a button per window, named like the window; each window has `separator "Left edge"`/`"Right edge"` to drag wider (`t.dragBy(edge, 260)`). Where the strip starts after setup depends on what's selected: set it with `t.scrollToStart(main)` in setup. ⌥⌘←/→ (previous/next session) don't wrap at the ends. The strip runs *under* the floating sidebars: a swipe over a sidebar scrolls the sidebar, so `reveal` picks a point whose topmost element is the strip (`elementFromPoint`).
- **Canvas view**: `t.pan(dx, dy)` is a two-finger drag over empty canvas (it finds a spot with no window under it: over a window, scrolling scrolls that window), `t.zoom(±px)` is ⌘-scroll at the pointer (negative zooms out), ⇧⌘1 fits everything (`t.press("1", "shift", "cmd")`), a double-click on a window's title flies to it, and windows move by their title (`t.dragBy(group.getByText(/^name$/), dx, dy)`). In Focus view only the selected window is shown, so a window opened from code in setup (`window.openTarget`) may be hidden: switch views first or wait with `{ state: "attached" }`.
- **Shortcuts with punctuation depend on the keyboard layout** (`]` is key code 30 only on US layouts): prefer a command's arrow or letter binding (⌥⌘← over ⇧⌘[), or `t.command(id)` where the keystroke isn't the point.
- **Drags are real.** `t.drag(from, to)` works for pointer-driven drags (a window by its title: the title bar has no role, so take its text inside the window's group, `group.getByText(/^Untitled/)`) and for HTML5 drag and drop (a Files row onto the terminal puts its path at the prompt).
- **A parked pointer can hover things.** The pointer starts in the middle of the window; a palette or popover that opens under it highlights the item under the pointer. Wait for the option you mean (`selected: true`) before pressing Return.
- **Find things by role and name**, never CSS classes: windows are `group "<name>, <kind>, <place>"`, the Navigator's sections are `tree "Windows"` with `treeitem`s, the palette is a `combobox` over `option`s, Files is `tree "Files"`, Settings rows name their controls. If something can't be found by role and name, fix its accessibility in the app (and `pnpm e2e:a11y` keeps it fixed), don't reach for a class.
- **Don't script scrolling to reach things.** `click`/`hover` scroll the target into view themselves, visibly. Write `scroll` only when scrolling is the point of the shot.
- **Typing makes the odd typo** and fixes it (a neighbouring key, noticed a character or two later, backspaced): `TYPING.terminal` ~20% of 12+ character texts, `TYPING.field` ~35%. Use `TYPING.exact` when the next step depends on the text (a search whose result you wait for). Seeded, so a run's typos repeat with its `--seed`.
- **Wait on the app, pace for people.** Wait for state with locators (`.waitFor()`); use `pause` only so viewers can follow (0.8–1.5 s on a result).
- **Setup is unrecorded.** Put what the video shouldn't show (opening windows, getting into a state) in `meta.setup`.
- **Tours that need a model** (a Magic widget build) set `meta.ai: true`. The runner takes the person's key from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`/`OPENAI_KEY`) or `~/.secrets`, writes it only into the fixture's `secrets.json` (0600), picks the provider, and deletes the file after the run. Never print or log a key. Such runs cost a little and build something slightly different each time: say so when asking to run one. A Magic build starts from New…: type the prompt, then click the last option, `Make “<prompt>” with Magic`. It runs on the smart tier (`claude-opus-5-5` by default): the first visible step can take more than 12 s, and the build is cut off when the run ends (the core stops), so hold long enough for what the shot should show, or wait for the window's state before ending. Check `/private/tmp/cmd-tours/<name>/logs/core.log` (`[magic] run …`) to see what the build did.
- The fixture lives at `/private/tmp/cmd-tours/<tour>/` with Kai's home at `…/kai`: cmd shows paths under it as `~`, but a window *on* the home folder shows its parent in full; keep shots inside `~/src`, `~/notes`.
- Never put the user's real files, sessions, names or tokens in a tour: the fixture (`src/fixture.ts`) gives a demo prompt (`~ ❯`), an empty transcripts folder and its own home.

## Running one

The app runs from its build, so build first after app changes:

```sh
pnpm build
pnpm tour packages/tours/tours/first.tour.ts            # → .cmd-dev/tours/out/first/
pnpm tour packages/tours/tours/first.tour.ts --seed 2 --out /some/dir
```

**Tell the user before every run** and wait for their go: for the length of the tour their real mouse and keyboard are taken over, a cmd dev window opens on their screen, and they must not touch anything. Moving the mouse stops the run ("the mouse moved…"); a key press would go into the tour. A run that fails mid-way still records up to there.

Output in the run's folder: `raw.mov` (no cursor, square corners), `events.json`, `meta.json` (window rect on screen, scale, `t0`/`t1`), `window.png`, `cursors/`, and `tour.mp4`. Re-render without recording again (another wallpaper, a bigger cursor): `node packages/tours/src/post.ts <run dir> [--wallpaper img] [--cursor 1.5] [--clicks]` (about 30 s for 45 s of video).

**Check your work by looking**, not by the exit code: pull frames at the moments that matter and read them.

```sh
ffmpeg -v error -ss 8.7 -i preview.mp4 -frames:v 1 -vf scale=1100:-1 frame.png
node -e 'const e=require("./events.json"),m=require("./meta.json");for(const x of e.filter(x=>x.type==="down"))console.log(((x.t-m.t0)/1e9).toFixed(2),x.x,x.y)'   # click times
```

Verify the pointer's tip sits on what it clicks, text is crisp, nothing personal is visible, and the shot reads.

When a run stops mid-way, the error says where (`no open menu item "Open"`, a locator timeout, `the mouse moved (it's at …, the tour left it at …)`). The recording up to there is in the run folder. Fix, then ask the user before running again.

## Working on the helper

- Shortcuts are played like a keyboard: modifier keys down, the key, modifiers up (`key()`); typed characters set empty flags. Posting a key with the Command flag but no Command press left the event source thinking Command was held, and the text typed after `⌘K` went out as shortcuts.
- ffmpeg with `-loop 1` image inputs never ends on its own: give the output `-t` (the first composite ran until a timeout killed it).
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

- Post: camera zoom on clicks (product-video polish, optional; ffmpeg's crop here can't take per-frame commands, so it needs another way).
- Menu-bar menus: the items are found the same way once a menu is open, but opening one (clicking its title in the menu bar) isn't wrapped yet; the menu bar strip itself isn't in the recording (it's the system's, not cmd's).
