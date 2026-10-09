# Motion and visual stability

How windows, sidebars and workspaces move, why, and how it's measured. The engine is
`apps/desktop/src/renderer/src/motion.ts`; the harness is `e2e/motion.mjs`
(`pnpm e2e:motion`). The vocabulary (curves, named timings, presence, FLIP) is the kit's,
`packages/ui/src/motion.ts`, with the same values as tokens for CSS; a test
(`apps/desktop/test/motion-css.test.ts`) keeps the stylesheets on them.

## Rules

1. **One curve.** Everything that moves a window, a sidebar or a workspace glides on
   one critically damped spring (no bounce, response 0.26 s, done in 382 ms).
   JS uses `glide()`/`TileMotion`; CSS and Web Animations use `--glide` /
   `--glide-dur` (tokens.css), the same spring sampled into `linear()`. A test
   keeps them identical.
2. **Position and size move together.** A window never takes its new size at
   once while its position glides (that was the ⌘↩ jitter: the edge jumped 570 px
   and slid back). Shown size and scale spring separately, so what's on screen
   grows or shrinks steadily even when a zoomed canvas is involved.
3. **Content is laid out once per move.** While a window glides, its content
   holds one size, the larger of before and after, clipped by the window. A
   terminal is refit once (not every frame, not at the start of every move), and
   nothing reflows inside a moving window.
4. **One move per change.** A view switch moves the track (the strip's scroll,
   the canvas camera) at once, and every window goes on from where it was on
   screen (`remap`). There's no glide followed by a reveal: whatever else moves the
   track for the switch (the viewport settling under the sidebars, showing the
   selection, the first fit of the canvas) is part of the same jump.
5. **What's painted is the start.** A retarget before anything of the last one
   was painted starts from what's on screen (`fresh`). A glide under way keeps its
   speed when it's interrupted, so ⌘↩ twice turns smoothly. A stalled frame pauses
   a glide rather than skipping it: the clock steps at most 34 ms.
6. **Following is instant.** Resizing the app window, dragging, resizing a strip
   window or a canvas window: the windows follow in the same frame, with no glide
   trailing the pointer or the window's edge.
7. **Nothing pops.** Focus mode fades the other windows where they are, and a
   new window scales in from 96%. A closed window fades out where it was (a ghost:
   a copy without its pages and canvases). A window moving to or from a sidebar
   glides between the two. A shown or hidden sidebar slides in from or out to its
   edge.
8. **Workspaces are a vertical stack.** Switching to the next workspace, everything in the
   old one (sidebars, the Navigator, windows, widgets) leaves out the top while the
   new one rises from the bottom; the previous workspace comes the other way. It's one
   element-scoped View Transition on the stage: the old workspace is a snapshot, the
   new one stays live, and the top bar and footer stay put.
9. **Chrome comes and goes too.** Sheets, popovers, menus, toasts, the palette and its
   pickers fade out (`usePresence` in `@cmd/ui`) and the palette glides between
   sizes. Find bars open and close. List rows that move (the Navigator, Agent
   Activity, notifications, toasts) glide there (`useFlip`), and new ones fade in.
   The selection ring changes with the dimming. Browser windows fade in over the
   well instead of flashing white.
10. **Content is laid out once, at its final size, as a move starts**, so moves end
   without a reflow. Terminal rows follow the window every frame; columns and the
   PTY's size follow at most every 100 ms.
11. **Reduced motion** (macOS Reduce Motion) makes all of it instant, and nothing loops.

## Why not View Transitions for everything

A View Transition snapshots the old state as an image and blocks input until it's
done. That suits a discrete swap where nothing has to keep moving through it, like
switching workspaces. It doesn't suit windows that are live (terminals, pages),
interrupted (⌘↩ twice) or following the pointer, and it can't hold a terminal's
size through a move. Those use TileMotion, frame by frame.

## The harness

How to work with it (running, reading, adding scenarios, the shapes problems take):
the `motion` skill (`.claude/skills/motion/SKILL.md`).

`e2e/motion.mjs` launches the built app on a throwaway core and sets up four
windows (a terminal, a text window, a file browser, a Markdown preview). It then
plays ⌘↩, view switches, sidebars, docking, opening and closing windows,
resizing the app window and switching workspaces. After each painted frame (a task
posted from the frame's rAF, so it reads what was on screen) it records every
window's rect, its content's rect, opacity and visibility, plus content resizes
and long animation frames. It scores:

| issue    | meaning |
|----------|---------|
| instant  | a window moved or resized over 16 px in one frame, with no motion |
| snap     | one frame took over half of a move that was otherwise animated |
| desync   | its size jumped while its position glided |
| wobble   | an edge changed direction (jitter, overshoot) |
| drift    | content slid inside its window |
| pops     | a window on screen appeared or vanished in one frame |
| lag      | while the app window was resized, a window moved a frame after it did |
| shifts   | the Layout Instability API saw an element jump outside the motion system |
| reflows  | content resizes (informational: one or two per move is the design) |

`--only a,b` runs some scenarios, `--dump` saves raw frames, and `--film` saves a
screencast per scenario (`.cmd-dev/motion/film/*.mp4`). Results are appended to
`.cmd-dev/motion/results.jsonl`.

Before this work: 60 instant, 74 snap, 14 desync, 76 wobble and 12 pops over the
scenarios, with every terminal refit at the start of every move. Now all of them
are 0. The one drift left is a file browser's toolbar laid out differently in a
sidebar, which isn't motion.
