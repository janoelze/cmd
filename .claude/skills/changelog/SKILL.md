---
name: changelog
description: Write or edit cmd's CHANGELOG.md, the release notes users see in What's New after an update and on the GitHub release. Use before every release (the release skill sends you here), and when the user asks to write, fix, reword or backfill release notes, a changelog entry or "what's new".
---

# Writing the changelog

`CHANGELOG.md` at the repo root is the one source of release notes. The app parses it
(`apps/desktop/src/shared/changelog.ts`) and shows every release newer than the one a person last
saw in **What's New** (it opens by itself after an update, and from the status bar's sparkles and
Help → What's New). CI publishes the release's section as the GitHub release notes. So every
entry is read by users, inside the app, right after they updated.

Entries are written **at release time**, from what changed since the last tag, not by each branch
(parallel worktrees would conflict on the file). You read the commits and the diff, then write for
people who use cmd and never read its code.

## Workflow

1. See what changed since the last release:
   ```sh
   last=$(git describe --tags --abbrev=0 --exclude='*-*')
   git log --reverse --format='%h %s' "$last"..HEAD
   git diff --stat "$last"..HEAD -- . ':!website' ':!docs'
   ```
   Open the diff of any commit whose subject doesn't tell you what a user notices.
2. Sort each change: does a user notice it? Leave out refactors, tests, CI, docs, the website,
   README, internal renames, performance work nobody can feel, and fixes to things that never
   shipped (a bug introduced and fixed since the last tag). Fold several commits about one feature
   into one entry.
3. Write the new section at the top (format below), date it today, and validate:
   ```sh
   node scripts/changelog.mjs check <version>    # the format and the style rules below
   node scripts/changelog.mjs notes <version>    # what the GitHub release will say
   ```
   `pnpm test` runs the same lint over the whole file.
4. Show the user the section before tagging. They may reword it; their wording wins.
5. Commit it by itself: `Changelog for v<version>`.

If nothing a user notices changed (CI or signing fixes), write a one-line summary and no lists:
"Fixes to how cmd updates itself." A release never ships without a section; `pnpm release` and
CI both refuse.

## Format

```markdown
## 0.10.0 — 2026-10-06

Optional one-line summary of the release, shown as its headline.

### New

- **What's New.** After an update, cmd shows what changed since the version you had. Reopen it from the sparkles in the status bar.

### Improved

- The command palette finds windows by their folder as well as their title.

### Fixed

- Terminals no longer lose their last line when the window is resized.
```

- Heading: `## <version> — <YYYY-MM-DD>` with an em dash. Newest first. No prereleases.
- Sections, in this order, each optional but not empty: `### New`, `### Improved`, `### Fixed`,
  `### Removed`. A release needs at least one entry or a summary.
- One `- ` bullet per entry, on one line. Inline Markdown: `**bold**`, `` `code` ``, `[links](https://…)`.
- **New** entries start with a bold name, ending in a period: `**Magic widgets.**` Then one or two
  sentences on what you can do now. Other sections don't need a bold name.

## Style

Follow the voice in `docs/15-positioning.md`: calm, plain, concrete, first-hand.

- **Say what the user sees or can do,** in the present tense. "Closed windows can be reopened with
  ⇧⌘T." Not "Added support for window restoration."
- **Fixed entries describe the fixed behaviour or the symptom that's gone,** not the cause:
  "Pasting into a terminal no longer drops the last character." Not "Fix off-by-one in paste
  handler."
- **One or two short sentences,** each ending with a period. Under 240 characters.
- **Name things as the app names them:** windows, spaces, the desk, agents, sessions, Magic
  widgets, the command palette. Menu paths as `Settings → Terminal`. Shortcuts as the menu shows
  them (⌘K, ⇧⌘T). Setting keys in backticks only when someone would type them (`updates.mode`).
- **No internals:** no file names, function names, RPC methods, process names (core, PTY host),
  OSC numbers, commit hashes, PR numbers or issue numbers. "Terminals keep running while cmd
  updates", not "the PTY host survives core restarts".
- **No commit-message shape:** no `fix:`/`feat:` prefixes, no "website:", no trailing
  semicolon lists, no "various", "minor" or "several improvements".
- **No hype, no exclamation marks.** Avoid: supercharge, unleash, revolutionary, seamless(ly),
  blazing, powerful, AI-powered, agentic, autonomous, next-generation, 10x, vibe, game-changer.
- **Don't apologise or thank** ("Sorry about…", "Thanks to…"). Credit a contributor only if the
  user asks.
- **Lead with what matters most:** the biggest change first within each section.

The lint (`lintChangelog` in `apps/desktop/src/shared/changelog.ts`) catches the mechanical part
of this: the format, periods, length, banned words, commit prefixes, hashes and issue numbers.
The rest is on you. When in doubt, read the last few releases and match them.

### Before and after

| Commit | Entry |
|---|---|
| `Popover: re-place when its content resizes, so one above its anchor stays attached` | Fixed: Popovers stay attached to their button when their content grows. |
| `Magic windows are now Magic widgets` | Improved: Magic windows are now called Magic widgets. |
| `core: restore resurrects lost panes under the same id, resuming agent sessions` | New: **Terminals survive restarts.** After a crash or a reboot, cmd reopens your terminals and resumes the agent sessions that were in them. |
| `website: hack the planet` | (left out) |
