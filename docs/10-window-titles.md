# Window titles: information architecture

Every window shows up in four places: its **title bar**, its **sidebar row**, the **status bar** (when selected) and the **command palette**. Today each window type decides on its own what goes where (`label`, `detail`, `meta` in `windows/registry.ts`, plus terminal special cases in `model.ts`, `TileTitle.tsx` and `StatusBar.tsx`). The same fact lands in different slots depending on the type, so the surfaces don't read alike. This doc sets one set of fields, one meaning per field, and one rule for which surface shows which field.

## Fields

Every window, whatever its type, is described by the same six fields:

| Field | Question it answers | Always present |
|---|---|---|
| **Mark** | What kind of thing is this, and does it need me? | yes |
| **Name** | What is it about? | yes |
| **Kind** | What is running or open in it? | yes |
| **Place** | Where does it live? | when meaningful |
| **Status** | What is its live state? | when there is one |
| **Dirty** | Does it have unsaved changes? | when true |

### Mark

- An agent terminal shows its **status light** (needs input, done-unseen, working, idle…). State is what matters about an agent, so the light wins over the icon.
- Every other window, plain shells included, shows its **type icon** (the SF Symbol from the core's window type: `terminal`, `globe`, `folder`, `doc.text`, `doc.richtext`).
- A plain shell has no state worth a light. Its hollow "shell" light reads as "agent, idle" and is retired in favour of the `terminal` icon.

### Name

The one thing you'd call the window by.

- Short, no path, no type word. `README.md`, not `~/src/cmd/README.md` and not `Text: README.md`.
- Comes from the content, never from where the window is.
- Fallbacks in order, ending at the type's title (`Terminal`, `New Tab`, `Files`) only when there is nothing else.

| Type | Name |
|---|---|
| Agent terminal | agent name → terminal title (non-generic) → last prompt → spawn prompt → agent kind |
| Shell terminal | terminal title (non-generic) → foreground process → `Terminal` |
| Browser | page title → host → `New Tab` |
| Files | folder name (`cmd`; `/` for the root) |
| Text, Markdown | file name (`README.md`) |

### Kind

What is running or open, in one lowercase word. It disambiguates windows with similar names (`README.md` in the editor vs. in the preview).

| Type | Kind |
|---|---|
| Terminal | foreground process (`zsh`, `claude`, `vim`) |
| Every other type | the type's title, lowercase (`browser`, `files`, `text`, `markdown`) |

### Place

Where the window lives, as context for the name. **It never repeats the name.**

| Type | Place |
|---|---|
| Terminal | working directory |
| Browser | host (`github.com`), without scheme or `www.` |
| Files | the shown folder's parent |
| Text, Markdown | the file's folder |

Paths are shortened with `~` (`shortPath`). When space runs out, a path keeps its end (`…/src/cmd`), since the end is the specific part.

### Status

Live, changing state, worded as a short phrase. One status per window; the most important wins.

| Type | Status (first that applies) |
|---|---|
| Agent terminal | agent state: `Needs input`/its question, `Working…`/its detail, `Done 3m ago`, `Failed`, `Exited`, `idle` |
| Shell terminal | none |
| Browser | `Loading…` while loading, else none |
| Files | none (later: item count, filter) |
| Text | `Edited` → `Read-only (…)` → `682 lines · 17 KB` |
| Markdown | `1,240 words` |

Resource usage (`512 MB · 4% CPU`) is not a status and not a window field: it appears only in the status bar (see Surfaces).

### Dirty

A dot after the name. Shown for unsaved changes only, on every surface that shows the name.

## Surfaces

Each surface shows a fixed subset of the fields, always in the same order. Types don't choose the order.

| Surface | Shows |
|---|---|
| **Title bar** | Mark · **Name** · Dirty ……… Kind \| Place \| Status (thin dividers between) |
| **Sidebar row** | Mark · **Name** · Dirty / second line: Status, else Place |
| **Status bar** | Usage of the selected window. In focus mode, which has no title bars: Mark · **Name** · Dirty · Kind · Place · Status · Usage |
| **Palette** | Mark · **Name** — Place |

Why these:

- **Title bar**: the window is right there, so it carries every field. The name sits left and is the only bold text. The rest is right-aligned and dim, and gets dropped from the right (Status first, Name last) when the window is narrow.
- **Sidebar row**: the second line answers "does this need me?" first (Status) and "which one is it?" second (Place). An agent row shows `Needs input`; a shell row shows its folder; a text window shows `Edited` when dirty and its folder otherwise.
- **Status bar**: the title bar and sidebar already show every field, so repeating them here is noise. It keeps what nothing else shows: memory and CPU of the selected window's processes (when `ui.showResources` is on; the tooltip lists the heaviest processes). Windows without processes show nothing there. Focus mode is the exception: with no title bar, the status bar stands in for it.
- **Palette**: you're searching by name and telling look-alikes apart by place. Status changes too quickly to search by.

## Rules

1. **One field, one meaning.** A path is always Place, a process is always Kind. A type never puts a path in Status or a state in Place.
2. **No repeats on a surface.** If Kind or Place would equal the Name (a shell named after its process, a page titled with its host), drop it. A divider only follows a field that's shown.
3. **Name is never empty.** Every type has a fallback chain that ends at its type title.
4. **Mark is the only colour.** Status lights carry colour; text in the title bar and rows stays text/dim. The selected window brightens its title bar text, nothing else.
5. **Same wording everywhere.** A status string is produced once (by the window) and shown verbatim on every surface. No surface rewrites it.
6. **Types supply fields, not markup.** A window type returns values; the surfaces render them. Types don't render title-bar JSX.

## Motion

The title bar is a row of **slots**, one per field, always present in the DOM in the order above. A field that has no value leaves its slot empty and collapsed, not removed. Every change is then a transition of a slot that already exists, so nothing pops in or out. The sidebar row's second line and the status bar use the same slots.

### What animates

| Change | Example | Motion |
|---|---|---|
| Slot fills or empties | `Edited` appears; `Loading…` goes away | width 0 ⇄ auto and opacity 0 ⇄ 1 together; its neighbours slide over |
| Value replaced | `Working…` → `Done just now`; `zsh` → `claude` | old text scales down (0.8) and fades out in 100ms; only then does the new text scale up from 0.8 and fade in (160ms), so two values are never drawn over each other; the slot's width eases between the two, clipping instead of ellipsizing while it moves |
| Mark changes | light working → needs; shell icon → agent light | colour cross-fades; icon ⇄ light cross-fades with a slight scale (0.6 → 1) |
| Dirty set or cleared | first keystroke; save | dot scales in from 0 (out to 0) |
| Name changes | page title loads; agent renamed | cross-fade only, no movement: the name is the anchor of the row and shouldn't jump |

### What doesn't

- **Counting values** update in place, without animating: usage numbers, `3m ago`, word and line counts. They change too often, and motion on every tick makes the row restless. They use tabular figures so the width barely moves.
- **Opening a window, a mode switch, scrolling or panning**: slots start in their final state. Motion is for a state change on a window that's already on screen.
- **Windows off screen, or a canvas zoomed out past the point where the title is legible**: change instantly. Many windows changing at once (all agents finishing a batch) would otherwise animate dozens of title bars nobody can read.

### Timing

- Slot width and value swaps: **180ms**, the app's ease-out (`cubic-bezier(0.2, 0.8, 0.2, 1)`, same as window moves). Mark and dirty dot: **140ms**. Exits run a little faster than entries, so a swap never shows two values at full opacity.
- **Grace:** a slot that empties waits 250ms before collapsing, so a value that's replaced (⌘E remounting the view) swaps once instead of going out and coming back in. The sidebar's place-under-status fallback applies only after that grace.
- **No flicker:** a value is shown for at least **600ms** before the next one replaces it; changes in between are coalesced, and only the latest is shown. A brief state (a page that loads in 80ms) shouldn't flash: `Loading…` waits **200ms** before it appears and is dropped if the load finished first.
- **Reduced motion** (`prefers-reduced-motion`): opacity only, no width, slide or scale.

### Building it

`components/Slot.tsx` has `Slot`, `Mark` and `DirtyDot`; the CSS is under "title fields" in `styles.css`.

- A `Slot` keeps the outgoing value mounted until its exit animation ends, then drops it. No animation library.
- The width is set in px from the value's `scrollWidth` (+1px, since it is rounded) and eases with a CSS transition. It's measured only when the value changes, never per render. `scrollWidth` is layout px, so the canvas zoom doesn't distort it. Narrow windows still ellipsize, because the px width only acts as the flex basis.
- Entering and leaving values use CSS keyframes. Gaps between fields are padding inside each value, so an empty slot takes no space.
- The minimum dwell and the transient delay live in the slot's `useSettled`, not in each window type.
- `SlotMotion` (a React context) turns animation off per tile. `WindowsView` sets it from whether the tile is on screen and, on the canvas, whether the zoom is at least 50%.
- Marks sit in a 16px box, so icon canvases (even sizes up to 16) and the 8px light centre on whole pixels. Title bars draw their separator as an inset shadow, so the full 26px height centres the mark. Sidebar rows use whole-pixel line heights for the same reason.

## What changes in the code

The window view API (`windows/registry.ts`) replaces `label`, `detail` and `meta` with one function returning the fields:

```ts
interface WindowFields {
  name: string;
  kind: string;          // lowercase
  place?: string;        // already shortened
  status?: string;
  dirty?: boolean;
  light?: Led;           // agents only; otherwise the type icon is used
}

interface WindowView {
  kind: string;
  View: ComponentType<WindowViewProps>;
  fields(win: AppWindow, live: WindowStatus | undefined): WindowFields;
  menu?(win: AppWindow): MenuEntry[];
}
```

Terminals get the same function in `model.ts` (built from pane + agent), so `rowTitle`, `rowDetail`, `TileTitle`, `Sidebar`, `StatusBar` and the palette all read one `WindowFields` and lose their per-type branches.

Differences from today:

| Today | After |
|---|---|
| Plain shells show a hollow status light | `terminal` icon |
| Files: Place is the folder itself, repeating the name | the folder's parent |
| Text/Markdown: title bar shows the folder, sidebar and status bar show the full file path | the folder everywhere |
| Status bar shows `pane.foreground` for terminals but the type title for others; title bar shows Kind for terminals only | Kind for every type in the title bar |
| Terminal title bar has no agent status; sidebar has it | title bar shows Status too |
| Usage shows in the title bar and the status bar | status bar only |
| Status bar repeats process, path and agent state | only usage (all fields in focus mode) |
| Browser has no loading status | `Loading…` |
| Palette: terminals show cwd, other windows show their sidebar detail (a path, or an agent state) | Place for all |
| Types render title-bar JSX in `meta` | types return fields; one renderer |
| Title bar items appear and disappear instantly | fixed slots that animate in, out and between values |
