# Media Controls

A cmd widget: whatever the Mac is playing, from any app that tells macOS (Music, Spotify, a browser tab). The track's title, artist and album, a scrubber at its position with the time gone and left (it moves on by itself while playing; click or drag to seek), and **Previous**, **Play** or **Pause** and **Next**. The title bar says what plays; the footer says in which app, or why a control didn't go through.

It ships with cmd (Widget Library → Built-in), does the native Now Playing's job, and is written against the widget API like any package ([`@cmd/widget-api`](../../widget-api/README.md), [docs/57](../../../docs/57-builtin-widgets.md)).

- `src/nowplaying.tsx`: the widget.
- `src/nowplaying.test.tsx`: its tests against the fake host (`pnpm vitest run packages/widgets/nowplaying`).
- `src/nowplaying.story.tsx`: its states in the UI Workbench (`pnpm workbench widgets/nowplaying`).

Permissions: `media: ["read", "control"]` (API 1.2): `read` to see what plays (`cmd.media.get`), `control` for the buttons and the scrubber (`cmd.media.control`: one per press, on this Mac only, never from a paired device).

## How it differs from the native Now Playing

- **No cover.** The API has no element for a picture (`ApiNowPlaying.artwork` is there, as a data URL, but nothing draws it): a music note stands in. A 1.3 candidate (docs/57).
- **It asks every 2 seconds** what plays (`cmd.media.get`); the native view is told at once (`nowPlaying.changed`). A change of track or a pause from elsewhere shows up to 2 seconds late; its own controls look again at once.
- **One layout at every size**: the track over the controls, not the native view's iPod layout with a large cover when there is room.
- **It names the app** in its footer ("Playing in Spotify"), which the native view doesn't.
