---
name: release
description: Cut a cmd release (signed, notarized, auto-updating) and verify it, or test CI/signing changes with a prerelease. Use when the user says "release", "ship", "cut a version", "publish", "bump the version", or asks why a release is broken, unsigned or not updating.
---

# Releasing cmd

A release is a `v<version>` tag. CI (`.github/workflows/build.yml`) builds the tag on macOS. The
`mac` job signs with Developer ID, notarizes the dmg once (its ticket covers the app), staples
the dmg and the app, zips the stapled app for updates, and verifies all of that. A `release` job then publishes the files as a GitHub release and posts its notes to Discord's
#whats-new (not for prereleases). Installed apps update
themselves from it (`apps/desktop/src/main/updater.ts`).
DEVELOPMENT.md ("Packaging and releases") has the background. This skill is the checklist.

## 1. Before tagging

1. **Only release committed, finished work.** Other sessions often have uncommitted changes in this
   tree. `pnpm release` refuses a dirty tree. Never commit or stash someone else's work to make it
   clean. Commit your own files (stage partial files by hunk if a file mixes both), then ask the user
   what to do with the rest.
2. Run the checks on what you're releasing:
   ```sh
   pnpm typecheck && pnpm test
   pnpm e2e          # builds and drives the real app; ~2 min
   ```
   If e2e flags an "outdated" core while another session is editing `packages/core`, that's
   their edits changing the source hash mid-run, not a bug.
3. Pick the version: `patch` for fixes and small features, `minor` for bigger ones. Versions are
   never reused, even when a release was broken.
4. **Write the changelog. Load the `changelog` skill and follow it.** Users read this section in
   What's New right after they update, and it becomes the GitHub release notes and the #whats-new post. Write it from
   `git log <last tag>..HEAD` in that skill's format and voice: what a user notices, in plain
   words, with no internals and no commit-message phrasing. Show the user the section, commit it
   (`Changelog for vX.Y.Z`), and check it:
   ```sh
   node scripts/changelog.mjs check X.Y.Z
   ```
   You can't skip this. `pnpm release` refuses a version without a clean section, CI's tag build
   fails on it before notarizing, and `pnpm test` lints the whole file. Prereleases are exempt.
5. **Update the website's feature grid**, `website/public/_lib/features.json` (the product page's
   "what it does", three to a row). Read it against the new changelog section: add a feature a
   user would choose cmd for, fold a smaller one into the blurb it belongs to, fix blurbs and
   numbers the release made wrong (theme count, supported agents, shortcuts), drop what was
   removed, and take a `Beta` badge off once the feature is out of beta. Not every release
   changes it. Keep the page's voice (`docs/15-positioning.md`): a short title, one or two plain
   sentences. The limits (lengths, sentences, entries a multiple of 3, at most 2 badges, `Beta`
   or `New` only) are in `website/test/features.test.ts`:
   ```sh
   pnpm vitest run website/test
   ```
   Commit it with the changelog. It deploys with the next push to master (`.github/workflows/website.yml`).

## 2. Tag

```sh
pnpm release patch        # or minor | major | 0.3.0
```

`scripts/release.mjs` checks the version's `CHANGELOG.md` section, bumps
`apps/desktop/package.json`, commits `Release vX.Y.Z`, tags it and pushes the branch and tag
together. It refuses to run if the section is missing or doesn't pass the lint.

**Prereleases**, for testing CI, signing or packaging changes without shipping to users: tag
directly. No bump commit is needed: CI's Version step (`scripts/release-version.mjs`) writes the
tag's version into `apps/desktop/package.json` in its workspace, so the app, What's New and the
usage stats key all report the prerelease's version:

```sh
git tag -a v0.2.6-beta.1 -m v0.2.6-beta.1 && git push origin master v0.2.6-beta.1
```

A tag with a `-` becomes a GitHub prerelease. The updater only follows the latest non-prerelease,
so betas never reach installed apps.

A release tag (no `-`) must equal `apps/desktop/package.json`'s version, which `pnpm release` bumps.
Tag one by hand without the bump and CI's Version step fails the build before anything is published.

## 3. Watch CI

```sh
id=$(gh run list -L 5 --json databaseId,headBranch -q '.[]|select(.headBranch=="vX.Y.Z")|.databaseId' | head -1)
gh run watch "$id" --exit-status       # run it in the background; ~5–8 min, mostly notarization
gh run view "$id" --log | grep -E "status: |staple and validate|accepted|source=|::error|⨯"
```

The log should show `status: Accepted` (the dmg), `The staple and validate action worked!` twice
(dmg, then app), and in "Verify signature" `accepted` / `source=Notarized Developer ID` for both.

## 4. Verify the published release

Check what users actually download, not the CI copy:

```sh
cd "$(mktemp -d)" && gh release download vX.Y.Z -R janoelze/cmd
gh release view vX.Y.Z --json assets -q '.assets[].name'
# dmg, zip, their .blockmaps, latest-mac.yml
ditto -x -k cmd-*.zip . && codesign --verify --deep --strict cmd.app
spctl --assess --type execute -vv cmd.app                  # accepted, source=Notarized Developer ID
xcrun stapler validate cmd.app
spctl -a -t open --context context:primary-signature -vv cmd-*.dmg
```

**Without `latest-mac.yml`, installed apps can't update.** Check that it's there and that its
`version` matches. The release body should be the changelog section
(`gh release view vX.Y.Z --json body -q .body`).

## Rules

- **Never delete or move a published tag or release**, even a broken one. Installed apps and people
  may already have it. Fix forward with the next patch.
- **Releases must be Developer ID signed.** Squirrel.Mac only installs an update whose signature
  matches the running app's, so an ad-hoc signed release strands everyone who installs it. A tag
  build without the signing secrets fails in the Package step ("No signing secrets"), before
  anything is published; branch and PR builds stay ad-hoc signed.
- Don't hand out a `curl … | sh` command for a new `scripts/install.sh` before it's pushed to
  master.

## Roll back

There is no rolling back in place: installed apps follow the newest non-prerelease and only
update to a higher version, and published tags stay (see Rules). To undo a bad vX.Y.Z, release
the last good tree under a new, higher version:

```sh
git checkout -b rollback vX.Y.W                                    # the last good tag
git checkout master -- CHANGELOG.md apps/desktop/package.json      # master's notes, and the bad version to bump from
# write the new version's CHANGELOG.md section (changelog skill): what it undoes, in user terms
git commit -am "Changelog for vX.Y.Z+1"
pnpm release patch                                                 # vX.Y.Z+1 from the good tree; pushes the rollback branch and tag
git checkout master && git checkout rollback -- CHANGELOG.md apps/desktop/package.json
git commit -m "Release vX.Y.Z+1 (rollback)"                        # master takes the notes and version; the tag keeps the tree
```

Then fix forward on master as usual: the next release is higher again. To roll back only part of
a release, `git revert` the bad commits on master and `pnpm release patch` instead. `pnpm release`
refuses a version that isn't higher than every release tag.

## When it fails

| Symptom | Cause / fix |
|---|---|
| `No signing secrets (MAC_CERT_P12_BASE64)` (CI's Package step on a tag) | The certificate secrets are gone or renamed. Restore them (Secrets and credentials below) and release the next patch: the failed tag stays, unpublished. |
| `vX.Y.Z doesn't match apps/desktop/package.json` (CI's Version step) | The tag was pushed without `pnpm release`'s bump. Release the next patch with `pnpm release`. |
| `CHANGELOG.md has no section for X.Y.Z` (release.mjs or CI's Changelog step) | Write the section with the changelog skill and commit it. If CI failed on a pushed tag, the tag stays: release the next patch with the section. |
| `SecKeychainUnlock: passphrase not correct` | electron-builder's own CSC_LINK keychain. CI imports the cert into its own keychain instead; keep it that way. |
| `::error::Certificate set but no APPLE_API_*` | Notarization secrets missing. Gatekeeper blocks unnotarized Developer ID apps, so CI refuses. |
| Notarization `Invalid` | `xcrun notarytool log <submission id> --key … --key-id … --issuer …` lists the unsigned or untimestamped binaries. |
| `A timestamp was expected but was not found` locally | The Agent Safehouse sandbox blocks codesign's timestamp request. Sign in CI, or outside the sandbox. |
| "cmd is damaged" for users | The release wasn't properly signed (v0.2.4 and earlier). The fix is a new signed release; users reinstall once. |
| App doesn't update | Check `~/Library/Logs/cmd/update.log` and Settings → About. Usual causes: the release lacks `latest-mac.yml`, the app runs from the dmg or a translocated copy, or `updates.mode` is off. |

## Secrets and credentials

GitHub repo secrets (`gh secret list`):

| Secret | What |
|---|---|
| `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD` | "Developer ID Application: Jan Oelze (6SP9XCYSJ5)" with its key, as a base64 .p12 |
| `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect API key (Developer role), used for notarization |
| `APPLE_TEAM_ID` | `6SP9XCYSJ5` |

The certificate lives in the login keychain. To re-export it (for example after it's renewed), the
keychain export contains every identity, so keep only the Developer ID one:

```sh
security export -k ~/Library/Keychains/login.keychain-db -t identities -f pkcs12 -P "$PW" -o all.p12
openssl pkcs12 -legacy -in all.p12 -passin pass:"$PW" -nodes -out all.pem
# split all.pem; match cert and key by `openssl x509 -pubkey` / `openssl pkey -pubout`
openssl pkcs12 -export -legacy -in devid.cert.pem -inkey devid.key.pem -passout pass:"$NEWPW" -out devid.p12
base64 -i devid.p12 | gh secret set MAC_CERT_P12_BASE64 && printf %s "$NEWPW" | gh secret set MAC_CERT_PASSWORD
rm all.p12 all.pem devid.*
```

Use `-legacy`, because macOS's `security import` can't read OpenSSL 3's default .p12 encryption.
The Developer ID certificate is valid for 5 years. Apps signed before it expires keep working, but
new releases need a renewed one. The App Store Connect key doesn't expire, but it can be revoked;
make a new one in App Store Connect → Users and Access → Integrations.
