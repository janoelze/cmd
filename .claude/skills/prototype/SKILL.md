---
name: prototype
description: Design, redesign or restyle a piece of cmd's UI (a dialog, sheet, form, control, view) by iterating on it with the user in the Workbench, a window that shows one component in the real app. Use when the user wants to prototype, mock up, polish, align or "look at" UI, asks how something looks, or gives visual feedback (spacing, borders, sizes, colours, themes) on a component, and before building a new UI piece that needs the user's eye.
---

# Prototyping UI in the Workbench

The Workbench (`apps/desktop/src/renderer/workbench.html`, dev builds only) renders one variant of a `*.story.tsx` file inside the real Electron app: the app's styles, the kit, native SF Symbols, the real preload and a real core. Nothing is a mock, so whatever you change in a story's component *is* the change in the app; there is no porting step afterwards. The user watches the window while you edit, HMR updates it, and you take screenshots of the same window to check your work.

## Setup

In the task's worktree (CLAUDE.md, "one git worktree per task"):

```sh
pnpm workbench <story>          # run in the background; it stays in the foreground
```

It starts `electron-vite dev` on its own instance (`.cmd-dev/workbench`, a separate CMD_HOME: own core, settings, no API keys) with the DevTools port open, and opens the Workbench instead of the app window. Wait until it answers before driving it (`pnpm workbench goto <story>` succeeds). `pnpm workbench stop` quits it with its core and PTY host. If the user closes the window, the process exits; start it again.

The toolbar picks story, variant and theme ("Theme from Settings" follows the instance's settings live). The URL holds the choice: `workbench.html?story=feedback&variant=Sent&theme=gruvbox-dark`.

## Stories

A story is `<Component>.story.tsx` next to the component; each named export is a variant (a component without props). They are found with `import.meta.glob`, so there is nothing to register. The story id is the file name, lower case (`Feedback.story.tsx` → `feedback`).

```tsx
// Workbench stories (pnpm workbench feedback): the feedback sheet, with a stand-in for main's webhook.
import { Feedback, type FeedbackApi } from "./Feedback.tsx";

const noop = () => {};
const works: FeedbackApi = { feedbackStatus: async () => ({ available: true, reason: null }), sendFeedback: async () => {} };

export const Empty = () => <Feedback onClose={noop} api={works} />;
export const Filled = () => <Feedback onClose={noop} api={works} initial={{ kind: "bug", message: "…" }} />;
```

Make every state reachable, because the user will want to see all of them:

- **Inject the bridge calls** a component makes, defaulting to the real ones: `api = cmd`, typed `Pick<CmdBridge, "feedbackStatus" | "sendFeedback">`. Stories pass stand-ins (works, fails, unavailable, slow).
- **Add an `initial` prefill prop** where it is a real feature too (a bug report from an error).
- **Reach the remaining states from the story** by doing what the user would: press the button once it is enabled (`useSend` in `Feedback.story.tsx`), paste into a field (`Pasted` in `SecretField.story.tsx`). A wrapper element used for that gets `display: contents`, so it doesn't change the layout.
- **One story with every state side by side** (`SecretField.story.tsx` → `States`) is often better than one variant each: one shot shows them all.
- Real flows work too: the AI step's key fields talk to the real core, which asks the real provider.

Stories stay in the repo after the work: they are the component's spec, and the next change starts from them.

## The loop

1. Write or update the story, and point the window at it: `pnpm workbench goto <story> [variant] [--theme id]`.
2. Edit the component or the kit. HMR updates the user's window.
3. Look before you report: `pnpm workbench shot <story> <variant> --theme <id>`, then Read the PNG. Say what you changed and what you see, in a line or two.
4. The user reacts to the window ("more air", "the borders don't connect", "Save buttons feel retro"). Expect several rounds per piece, and keep each round small and fast.
5. Commit on the branch when a round lands.

**Before calling something done, check it in every theme**, not just pastel-dark: a sweep over all built-in themes into one contact sheet (below). Tinted light themes (Solarized, Gruvbox, Latte, Lotus) and low-contrast dark ones are where things vanish.

## Commands

```sh
pnpm workbench goto <story> [variant] [--theme id]
pnpm workbench shot [story] [variant] [--theme id] [--out file.png] [--window]
pnpm workbench matrix <story> [--themes a,b,c]   # every variant × themes → .cmd-dev/shots/wb
pnpm workbench eval '<js>'                        # run JS in the window, print the result
pnpm workbench audit [story] [variant] [--theme id] # where each window's content sits against its edges; exits 1 on a problem
pnpm workbench stop
```

- **Shots are cropped to the component** (a dialog, else the stage's content) with a margin, and **always 2×**: the window is the user's, on whatever display at whatever size, so the script emulates 2× for the shot and restores it. `--window` for the whole window.
- **Every shot remounts the variant** (a `mount` URL param), because the user clicks and types in the same window. If a shot shows a state you didn't ask for, the user was interacting.
- **Shots wait for the theme** they asked for to be applied, and for the variant to render.
- **zsh doesn't split `$var`**: `for s in "feedback Filled"; do pnpm workbench shot $s` passes one argument. Write the arguments out, or use `${=s}`.
- `eval` is for interactions and measurements: paste a key, hover a link, read a computed colour (`getComputedStyle(el).boxShadow`), or list page errors.
- Change the instance's settings live by writing `.cmd-dev/workbench/settings.json` (window radius, outline, shadow, theme); write `{}` to reset.

Contact sheets for side-by-side review (Python with Pillow is available):

```sh
for t in $(grep -ho 'id: "[a-z-]*"' packages/ui/src/themes/*.ts | sed 's/id: "\(.*\)"/\1/' | sort -u); do
  pnpm -s workbench shot feedback Empty --theme $t > /dev/null
done
python3 -c "
from PIL import Image, ImageDraw; import glob
fs = sorted(glob.glob('.cmd-dev/shots/wb/feedback-Empty-*.png'))
ims = [Image.open(f).convert('RGB') for f in fs]
w, h = max(i.width for i in ims) // 2, max(i.height for i in ims) // 2
o = Image.new('RGB', (4 * w, -(-len(ims) // 4) * h), (60, 60, 60))
for k, (f, i) in enumerate(zip(fs, ims)):
    i = i.resize((w, h)); ImageDraw.Draw(i).text((6, 4), f.split('Empty-')[1][:-4], fill=(255, 0, 255))
    o.paste(i, ((k % 4) * w, (k // 4) * h))
o.save('.cmd-dev/shots/wb/sheet.png')"
```

Zoom into joins and edges with `Image.NEAREST` upscaling when the question is about single pixels.

## Where changes go

- **A window's inside** (its layout, toolbar, footer, table, chart, list, states) follows the **window-design** skill: its pieces, reference windows and rules. Start from the closest reference window.

- **The kit first.** A control or a look that a view lacks goes into `@cmd/ui` (with a gallery specimen in `packages/ui/gallery/Gallery.tsx`), not into the view's CSS. The goal for a view is no view CSS at all. Kit changes reach every screen, so after one, look at the other places it shows up (Settings, the palette, other dialogs) before handing back.
- **App-wide settings go on `:root`**, not on `.app`: dialogs are portalled to `<body>`, and the Settings window and the Workbench have no `.app` (see `look.ts`).
- **Core event subscriptions are per connection, and the last call wins.** A page that subscribes to a few event types cuts off the others; the Workbench subscribes to all of them so stories get `ai.updated` and the rest.

Design rules the sheets work settled:

- One inset per sheet (`--dialog-pad`) for the title row, body and footer, and a divided footer with the aside (status, a checkbox, PageDots) across from the actions.
- Controls in a form share their corner radius (`--radius`); an inner shape inside padding is concentric (`radius − padding`).
- Edges that meet must not overlap translucently, or the joins come out darker. Premix an edge over the fill it sits on when that fill is known and solid (`--field-edge` over `--field-bg`); otherwise draw one outline over the parts and stop the dividers short of it (joined buttons).
- Text fields sit in a darker well than their surroundings, so their edge is stronger than a button's, and it has to hold up inside a lighter group box too.
- A disabled primary button is still the primary action: the accent, faded. The way out of a recommended step is a ghost button.
- User-facing text follows the `copywriting` skill.

## Don't

- **Don't run `pnpm e2e` while iterating.** It takes minutes, takes focus away from the user and is flaky in the sandbox. Run it once at the end and fix what it finds then. Typecheck, unit tests and shots are the loop's checks.
- **Don't run prettier** (or any formatter): the repo is hand-formatted with long lines, and prettier rewraps whole files. Write code in the surrounding style.
- After a formatter or anything else rewrote a file, re-read it before a scripted edit: exact-match replacements fail silently on reflowed lines.

## Finishing

1. `pnpm typecheck && pnpm test`.
2. Show the user the change in place: the app itself, from the branch, on fresh state so first-launch screens show:
   `CMD_HOME=$PWD/.cmd-dev/app CMD_NO_SANDBOX=1 pnpm dev` (stop the Workbench first).
3. `pnpm e2e` once; fix what it finds.
4. `pnpm workbench stop`. Keep the stories.
