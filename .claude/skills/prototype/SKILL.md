---
name: prototype
description: Design, redesign or restyle a piece of cmd's UI (a dialog, sheet, form, control, view) by iterating on it with the user in the UI Workbench, the window that shows every component and story in the real app. Use when the user wants to prototype, mock up, polish, align, review or "look at" UI or components, wants a story for a component, asks how something looks, or gives visual feedback (spacing, borders, sizes, colours, themes) on a component, and before building a new UI piece that needs the user's eye.
---

# Prototyping UI in the UI Workbench

The UI Workbench (`apps/desktop/src/renderer/workbench.html`, dev builds only; docs/48) shows every component and story inside the real Electron app: the app's styles, the kit, its icons, the real preload and a real core. Nothing is a mock, so whatever you change in a story's component *is* the change in the app; there is no porting step afterwards. The user watches the window while you edit, HMR updates it, and you take screenshots of the same window to check your work.

Everything it shows is read from the sources (a catalog the TypeScript checker builds as the dev server runs, `renderer/src/workbench/catalog/`): a component's page (its JSDoc, a matrix of its union and boolean props, a playground with a control per prop, the story variants that render it, its props with types and defaults) and a story's page (every variant, each with the comment above its export). Nothing is registered by hand.

## Setup

In the task's worktree (CLAUDE.md, "one git worktree per task"):

```sh
pnpm workbench <target>                 # run in the background; it stays in the foreground
pnpm workbench <target> --headless      # the same without showing the window: for your own checks
```

It starts `electron-vite dev` on its own instance (`.cmd-dev/workbench`, or `$CMD_WORKBENCH_HOME`: own core, settings, no API keys) with the DevTools port open, and opens the UI Workbench instead of the app window (headless: no window and no Dock icon). Wait until it answers before driving it (`pnpm workbench goto <target>` succeeds). `pnpm workbench stop` quits it with its core and PTY host; closing its window quits it too. **Give the user's window and your headless one different `CMD_WORKBENCH_HOME`s**: stopping or restarting one instance never touches another.

**Start it once and keep it running for the whole task.** It is live: every edit to a component, story, stylesheet or the kit reaches the window by HMR, and `goto`/`shot` first wait until the window has your last edit (no `sleep` after an edit). It builds into `apps/desktop/out-dev`, not `out/`, so `pnpm typecheck`, `pnpm test`, `pnpm e2e`, `pnpm build` and commits all run beside it: never stop it (or `rm -rf apps/desktop/out`) for a check or a commit. Restart it only after editing main, the preload or the catalog's extractor (`catalog/extract.ts`), or when `goto` says it isn't running.

A target is a story, by its path (`shell/feedback`, `ui/overlay`; the old file-name ids like `feedback` still work), or a component (`ui/Button`). `pnpm workbench ls` lists them all, read from the sources (no window needed); `--json` for the whole catalog.

The toolbar: one theme or every theme at once, the stage width (natural, or 220/320/480/640 px, the widths windows get), the backdrop (well or window), the audit overlay (ruler: where each window's content sits against its edges), and the theme ("Theme from Settings" follows the instance's settings live). The URL holds the choice: `workbench.html?story=shell/feedback&variant=Sent&theme=gruvbox-dark&mode=themes&width=480`.

## Stories

A story is `<Component>.story.tsx` next to the component; each named export is a variant (a component without props), the doc comment above it its note, the file's header comment its description. Kit stories sit beside the kit (`packages/ui/src/<file>.story.tsx`). The catalog reads which components each variant renders (its JSX and the story's local helpers), so a component's page shows them; a test fails if a kit component isn't rendered by any story.

```tsx
// The feedback sheet, with a stand-in for main's webhook. Sent and Fails press Send themselves.
import { Feedback, type FeedbackApi } from "./Feedback.tsx";

const noop = () => {};
const works: FeedbackApi = { feedbackStatus: async () => ({ available: true, reason: null }), sendFeedback: async () => {} };

/** Nothing typed yet: Send waits for a message. */
export const Empty = () => <Feedback onClose={noop} api={works} />;
/** A bug report prefilled, as one from an error would be. */
export const Filled = () => <Feedback onClose={noop} api={works} initial={{ kind: "bug", message: "…" }} />;
```

Make every state reachable, because the user will want to see all of them:

- **Inject the bridge calls** a component makes, defaulting to the real ones: `api = cmd`, typed `Pick<CmdBridge, "feedbackStatus" | "sendFeedback">`. Stories pass stand-ins (works, fails, unavailable, slow).
- **Add an `initial` prefill prop** where it is a real feature too (a bug report from an error).
- **Reach the remaining states from the story** by doing what the user would: press the button once it is enabled (`useSend` in `Feedback.story.tsx`), paste into a field (`Pasted` in `SecretField.story.tsx`). A wrapper element used for that gets `display: contents`, so it doesn't change the layout.
- **One story with every state side by side** (`SecretField.story.tsx` → `States`) is often better than one variant each: one shot shows them all.
- Sheets work on a story's page: each variant's box is its own dialog layer (`DialogLayer`), so several sheets show at once, each in its box.
- Real flows work too: the AI step's key fields talk to the real core, which asks the real provider.
- What a component is for goes in its JSDoc, not in a story's note: the editor's hover and the component's page read it.

Stories stay in the repo after the work: they are the component's spec, and the next change starts from them. Kit stories also run in a plain browser for tests (`packages/ui/test/stage`; `stories.test.ts` renders every variant in three themes).

## The loop

1. Write or update the story, and point the window at it: `pnpm workbench goto <target> [variant] [--theme id]`.
2. Edit the component or the kit. HMR updates the user's window.
3. Look before you report: `pnpm workbench shot <target> <variant> --theme <id>` right after the edit, then Read the PNG. Say what you changed and what you see, in a line or two. An edit that doesn't compile comes back from `shot` with the compiler's error (and the shot is of the code before it); fix it and shoot again, no restart.
4. The user reacts to the window ("more air", "the borders don't connect", "Save buttons feel retro"). Expect several rounds per piece, and keep each round small and fast.
5. Commit on the branch when a round lands.

**Before calling something done, check it in every theme**, not just one: `pnpm workbench shot <target> [variant] --themes all` is one image of it in every built-in theme. Tinted light themes (Solarized, Gruvbox, Latte, Lotus) and low-contrast dark ones are where things vanish.

## Commands

```sh
pnpm workbench ls [--json]
pnpm workbench goto <target> [variant] [--theme id]
pnpm workbench shot [target] [variant] [--theme id | --themes all] [--out file.png] [--window]
pnpm workbench matrix <story> [--themes a,b,c]   # every variant × themes → .cmd-dev/shots/wb
pnpm workbench eval '<js>'                        # run JS in the window, print the result
pnpm workbench audit [target] [variant] [--theme id]   # where each window's content sits against its edges; exits 1 on a problem
pnpm workbench audit --all                        # every story, its Sizes too
pnpm workbench stop
```

- **Shots are cropped to the component** (a dialog, else the stage's content) with a margin, or to the page as far as it shows; **always 2×**: the window is the user's, on whatever display at whatever size, so the script emulates 2× for the shot and restores it. `--window` for the whole window.
- **Every shot remounts the variant** (a `mount` URL param), because the user clicks and types in the same window. If a shot shows a state you didn't ask for, the user was interacting.
- **Shots wait for the theme** they asked for to be applied, and for the variant to render.
- **zsh doesn't split `$var`**: `for s in "feedback Filled"; do pnpm workbench shot $s` passes one argument. Write the arguments out, or use `${=s}`.
- `eval` is for interactions and measurements: paste a key, hover a link, read a computed colour (`getComputedStyle(el).boxShadow`), or list page errors. `globalThis.workbenchCatalog` is the catalog, `workbenchAudit()` the audit.
- Change the instance's settings live by writing `<instance>/settings.json` (window radius, outline, shadow, theme); write `{}` to reset.
- Editing the catalog's extractor (`catalog/extract.ts`), main or the preload needs a restart; components, stories, stylesheets and the kit update live, and every command waits for them.

Zoom into joins and edges with `Image.NEAREST` upscaling (Pillow) when the question is about single pixels.

## Where changes go

- **A window's inside** (its layout, toolbar, footer, table, chart, list, states) follows the **window-design** skill: its pieces, reference windows and rules. Start from the closest reference window.

- **The kit first.** A control or a look that a view lacks goes into `@cmd/ui` (exported, documented in JSDoc, shown in a story beside it), not into the view's CSS. The goal for a view is no view CSS at all. Kit changes reach every screen, so after one, look at the other places it shows up (Settings, the palette, other dialogs) before handing back.
- **App-wide settings go on `:root`**, not on `.app`: dialogs are portalled to `<body>`, and the Settings window and the UI Workbench have no `.app` (see `look.ts`).
- **Core event subscriptions are per connection, and the last call wins.** A page that subscribes to a few event types cuts off the others; the UI Workbench subscribes to all of them so stories get `ai.updated` and the rest.

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
   `CMD_HOME=$PWD/.cmd-dev/app CMD_NO_SANDBOX=1 pnpm dev` (stop the UI Workbench first).
3. `pnpm e2e` once; fix what it finds.
4. `pnpm workbench stop`. Keep the stories.
