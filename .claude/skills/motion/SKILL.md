---
name: motion
description: Measure and fix how cmd moves: windows gliding (⌘↩, view switches, sidebars, docking, resizing), overlays coming and going (sheets, popovers, the palette, toasts, find bars), list rows moving, Space switches, and any layout shift or jump. Runs e2e/motion.mjs, a per-frame harness that scores jumps, snaps, wobble, pops, drift, lag and layout shifts, then fixes them with the motion system (TileMotion, usePresence, useFlip, --glide). Use when the user reports jitter, jumps, flicker, something that "pops", "snaps", "feels HTML-y" or janky, asks to audit or improve animations or visual stability, adds UI that appears, disappears, moves or resizes, or changes WindowsView, motion.ts, Dock, overlays or list views.
---

# Motion and visual stability

The rules, the engine and the harness are written up in `docs/37-motion.md`; read it first. This skill is how to work on them: measure, read what the numbers mean, fix the cause, measure again.

## The pieces

| what | where |
|---|---|
| Windows: position and size on one spring, content held at its final size, remaps when the track jumps, ghosts on close, moves to and from sidebars | `apps/desktop/src/renderer/src/motion.ts` (`TileMotion`, `glide`, `glideNow`, `slide`, `departed`/`arrived`, `ghost`) |
| Where windows go each render, track jumps, the strip's scroll, the canvas camera | `components/WindowsView.tsx` (the motion layout effect, `jumpTrack`, `trackOf`) |
| Overlays leaving, rows moving, the curve for the kit | `packages/ui/src/motion.ts` (`usePresence`, `usePresentValue`, `useFlip`, `glideTiming`) |
| The curve | `--glide`, `--glide-dur` in `packages/ui/src/tokens.css` (`apps/desktop/test/motion.test.ts` keeps it equal to the JS spring) |
| Space switches | `store.ts` `switchSpace` (a View Transition scoped to `.stage`) and its CSS in `styles.css` |
| The harness | `e2e/motion.mjs` (`pnpm e2e:motion`) |

## Running the harness

```sh
export CMD_HOME=$PWD/.cmd-dev    # in the worktree, as always
pnpm build                        # it drives the built app
node e2e/motion.mjs --label before --json            # every scenario, ~5 min
node e2e/motion.mjs --only "palette,find"            # some (others still run, unmeasured, to keep the state)
node e2e/motion.mjs --only "⌘↩" --dump --film         # raw frames + a video per scenario
```

- Run it in the background and write its output to a file in the scratchpad, then read the table. Piping it through `tail` shows nothing until the end.
- `--dump` writes `.cmd-dev/motion/frames-<scenario>.json`: every painted frame's rect, content rect, opacity, scale (`k`) and terminal screen (`x`) per window, plus chrome overlays, layout shifts and long frames. Print one window's series with a few lines of `node -e` to see exactly what moved when. It's the fastest way to the cause.
- `--film` saves `.cmd-dev/motion/film/<scenario>.mp4` and its frames. A contact sheet makes them easy to read at a glance: `ffmpeg -i <dir>/%04d.jpg -vf "select='between(n\,2\,13)',scale=480:-1,tile=4x3" -frames:v 1 sheet.jpg`. Look at the films. They show what the probe can't classify, like a window rendering at the wrong place for one frame.
- Results are appended to `.cmd-dev/motion/results.jsonl` with the commit and label, for before and after comparisons.

## Reading the table

| column | a real problem when |
|---|---|
| instant | a window moved or resized more than 16 px in one frame, in a scenario that should glide |
| snap | one frame took more than half of a move's path |
| desync | its size jumped while its position glided (the original ⌘↩ bug) |
| wobble | an edge changed direction by more than 1 px. Interrupted scenarios allow one change (`{ reversals: 1 }`) |
| drift | content slid inside its window (compared within one element; a sidebar lays content out its own way) |
| pops | a window or overlay appeared or vanished at more than 50% opacity, not covered by a ghost or a View Transition |
| lag | resizing the app window, a window moved a frame after the window did (`{ expect: "follow" }` scenarios) |
| shifts | the Layout Instability API saw an element jump. Spread over many frames means it's gliding by layout, which isn't counted |
| reflows | informational: content resizes. One or two per move is by design; a number per frame isn't |
| loaf / worst frame | long animation frames. The engine's clock pauses through them, but find the cause |

The issue lines under each scenario name the window (the last 6 characters of its id), the overlay (`.palette#0`) or the shifted element (a short selector path).

## Adding a scenario

In `e2e/motion.mjs`, the scenarios are plain calls in order. Each one starts from the state the previous one left.

```js
await scenario("name", () => menu("view.something"));                    // a menu command
await scenario("name", () => call("window.close", { id }), { settle: 900 }); // RPC; settle = ms sampled after
await scenario("name", () => win.keyboard.press("Escape"));              // keys, the mouse: Playwright
await scenario("name", act, { expect: "follow" });                       // must follow at once, not glide
await scenario("name", act, { reversals: 1 });                           // an interrupted move may turn once
```

Before a scenario, put the app in the state it needs: select with `selectNth(i)` or `window.__cmdSelect(id)`, and switch modes with `menu("view.grid")`. Add the scenario for whatever the user reported before fixing it, so the fix is measured.

## The process that worked

1. Measure first. Run everything with a label, and add scenarios for what the user describes. "Some jumps when I press ⌘+ and −" turned out to mean ⌥⌘+/−, which only the right scenario showed.
2. Dump and read the frames of one failing window before theorising. Each fix in this area came from a series of rects, not from reading the code.
3. Ask whether a flag is real before fixing it. The probe can be wrong: it read layout before ResizeObservers ran, sampled a window resized after paint, and counted sub-pixel rounding as wobble. Fix the probe when it is wrong, and write down why in a comment.
4. Fix the cause in the motion system, not with a special case in a view. Most problems were one of a few shapes (see below).
5. Run everything again with a new label, then `pnpm typecheck && pnpm test`, then commit.

## Shapes of the problems, and the fixes

- **Two things moving the same thing on different terms.** Examples: size snapping while position transitions; the track on a CSS transition while windows spring; a reveal scroll after a mode switch's glide; the camera fitting after a switch; a window growing while the strip scrolls on another clock. Fix: one spring, one clock (`glideNow`). The track jumps at once and `remap` carries windows from where they are on screen (`jumpTrack()` before any instant change to the scroll or camera).
- **A change that lands a frame or more late.** Examples: React state set from a ResizeObserver renders a frame later (use `flushSync` there); the viewport settling after a mode switch; the strip's offset clamped by the browser at the end of the frame. Fix: make it part of the same jump. A retarget before anything was painted starts from what was painted (`fresh` in TileMotion).
- **Velocity carried into a different direction.** Remaps and retargets within a frame or two of each other keep no velocity.
- **Elements that come and go.** Overlays use `usePresence` and `data-closing` CSS. List rows use `useFlip`. Windows get ghosts or `departed`/`arrived`. A sidebar slides (`slide`) and leaves the layout while it goes. A whole Space uses a View Transition on `.stage`.
- **Content reflowing.** Hold content at its final size for the whole glide (`freeze`), so it's laid out once as the move starts. Terminal rows follow every frame; columns and the PTY size are throttled to 100 ms (`terminals.ts`).
- **Stalls.** A long frame (a terminal refit, a WebGL context) pauses glides because the clock steps at most 34 ms. Find the stall with `loaf` (`work` vs `render` ms).

## Pitfalls

- Never set `transform`, `width`, `height` or `opacity` on a workspace window from React. TileMotion owns them, and React rewriting `className` drops classes, so TileMotion marks state with attributes (`data-morphing`, `data-hidden`, `data-held`).
- `getBoundingClientRect()` includes running transforms and animations: read it for "where it's shown", `offsetWidth` for "where it's laid out".
- A WebGL canvas can't be cloned, so a closed terminal's ghost fades without its text.
- View Transitions snapshot the old state, block input and need a persistent scope element. Use them only for discrete swaps (Spaces). A scope element that React replaces never animates.
- In the Agent Safehouse sandbox, `pnpm test`'s real-PTY tests can fail with `posix_spawnp failed`, on `master` too. It's not the motion code.
