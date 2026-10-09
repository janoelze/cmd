---
name: unreleased
description: List what would go into the next cmd release: the features, improvements and fixes on master since the last release tag. Read-only, writes nothing. Use when the user asks "what's unreleased", "what's in the next release", "what changed since the last release", "what would we ship", or wants to decide whether it's worth cutting a release.
---

# What's unreleased

A quick, read-only answer to "what would ship if we released now". It doesn't write the
changelog, bump anything or tag: that's the `release` and `changelog` skills.

## Steps

1. Find the last release and the commits since it, on `master` (the main checkout is always
   `master`; from a worktree, use `master` explicitly, not `HEAD`):
   ```sh
   last=$(git -C ~/src/cmd describe --tags --abbrev=0 --exclude='*-*' master)
   git -C ~/src/cmd log --reverse --no-merges --format='%h %s' "$last"..master
   ```
   If there are no commits, say "Nothing since v<x>." and stop.
2. Open a commit (`git show --stat <hash>`) only when its subject doesn't say what a user notices.
3. Sort each change, folding several commits about one feature into one line:
   - **New**: something people can do that they couldn't before.
   - **Improved**: something existing that works or looks better.
   - **Fixed**: a bug in a released version that's gone. A bug introduced and fixed since the last
     tag never shipped: leave it out.
   - **Not user-facing**: tests, CI, docs, the website, refactors, internal tooling (triage,
     tours, skills), licensing. Give these one line in total, as a count with a few examples.
4. Optionally mention branches in flight that aren't on `master` yet (`git worktree list`), as a
   separate note: they won't ship unless merged.

## Output

Reply in the terminal; no files. One short line per item, plain words, with the commit hashes in
parentheses so the user can look them up. Lead with the biggest change. End with a one-line
verdict: the version it suggests (`patch` for fixes and small things, `minor` for a new feature)
or "nothing worth a release yet".

```
Since v0.22.0 (5 commits):

New
- Image windows: images open in their own viewer with zoom, pan and ← → through the folder (af2a223, 9ad57b1, 36f4629)
- Visualizer widget: MilkDrop presets moving to the microphone, system audio or a window (8c35dd4)

Not user-facing: AGPL licence, test logging, triage --group (3 commits)

Suggests a minor release: 0.23.0.
```
