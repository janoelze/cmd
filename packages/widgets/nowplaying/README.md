# Media Controls

A cmd widget: whatever the Mac is playing, from any app that tells macOS (Music, Spotify, a browser tab), live. Its cover, the track's title, artist and album, a scrubber at its position with the time gone and left (it moves on by itself while playing; click or drag to seek), and **Previous**, **Play** or **Pause** and **Next**. The title bar says what plays; a footer says why when a control didn't go through.

It has the native Now Playing's three faces, switched by the window's size at the same numbers: up to 280 px tall, a thumbnail in front of the title with the player at the bottom; from 340×440, a centred column under the cover, like an iPod; between, the cover takes the room above the track, whose title grows with the column.

It ships with cmd (Widget Library → Built-in), does the native Now Playing's job, and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/57](../../../docs/57-builtin-widgets.md)). It is the example of API 1.3's `Adapt` (a face per size, switched by cmd without waking the widget), `Picture` (the cover, from a `data:` URL) and `useMedia()` (what plays, pushed on each change; the cover only when it changes).

- `src/nowplaying.tsx`: the widget.
- `src/nowplaying.test.tsx`: its tests against the fake host (`pnpm vitest run packages/widgets/nowplaying`).
- `src/nowplaying.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/nowplaying`).

Permissions: `media: ["read", "control"]`: `read` to see what plays (`useMedia`, API 1.3), `control` for the buttons and the scrubber (`cmd.media.control`: one per press, on this Mac only, never from a paired device). On a cmd before API 1.3 it says it needs a newer one.

## How it differs from the native Now Playing

- **The large face isn't a column.** The native one is at most 80% of the window and 360 px wide, the cover as wide as that and 200 px shorter than the window; the API has no width for a column, so the cover takes the room left (a little larger) and the scrubber runs from inset to inset.
- **The title grows further.** `Text fit` grows up to the display size (20 px); the native title stops at 80% of it (16 px). With room it is up to 4 px larger, and the cover above it a little smaller.
- **Before the first value it says nothing plays**, where the native view is blank for a moment: `useMedia()` is null both before the first value and while nothing plays.
- **A refused read is the runtime's error**, not a state of its own: `useMedia()` throws a refusal (a person's copy without `media: ["read"]`; cmd grants a built-in what it declares).
- **A control that fails says so** in a footer; the native view's controls fail silently.
