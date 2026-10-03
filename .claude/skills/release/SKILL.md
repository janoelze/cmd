---
name: release
description: Cut a cmd release (signed, notarized, auto-updating) and verify it, or test CI/signing changes with a prerelease. Use when the user says "release", "ship", "cut a version", "publish", "bump the version", or asks why a release is broken, unsigned or not updating.
---

# Releasing cmd

A release is a `v<version>` tag. CI (`.github/workflows/build.yml`) builds the tag on macOS and
Windows. The `mac` job signs with Developer ID, notarizes and staples the app and the dmg, and
verifies all of that. The `windows` job builds an unsigned NSIS installer and a zip. A `release`
job then publishes both platforms' files as one GitHub release. Installed apps update themselves from it (`apps/desktop/src/main/updater.ts`).
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

## 2. Tag

```sh
pnpm release patch        # or minor | major | 0.3.0
```

`scripts/release.mjs` bumps `apps/desktop/package.json`, commits `Release vX.Y.Z`, tags it and
pushes the branch and tag together.

**Prereleases**, for testing CI, signing or packaging changes without shipping to users: tag
directly. CI takes the version from the tag, so no bump commit is needed:

```sh
git tag -a v0.2.6-beta.1 -m v0.2.6-beta.1 && git push origin master v0.2.6-beta.1
```

A tag with a `-` becomes a GitHub prerelease. The updater only follows the latest non-prerelease,
so betas never reach installed apps.

## 3. Watch CI

```sh
id=$(gh run list -L 5 --json databaseId,headBranch -q '.[]|select(.headBranch=="vX.Y.Z")|.databaseId' | head -1)
gh run watch "$id" --exit-status       # run it in the background; ~5–8 min, mostly notarization
gh run view "$id" --log | grep -E "notarization successful|status: |accepted|source=|::error|⨯"
```

The log should show `notarization successful` (app), `status: Accepted` (dmg), and in "Verify
signature" `accepted` / `source=Notarized Developer ID` for both.

## 4. Verify the published release

Check what users actually download, not the CI copy:

```sh
cd "$(mktemp -d)" && gh release download vX.Y.Z -R janoelze/cmd
gh release view vX.Y.Z --json assets -q '.assets[].name'
# macOS: dmg, zip, their .blockmaps, latest-mac.yml
# Windows: -win-x64-setup.exe (+ .blockmap), -win-x64.zip, latest.yml
ditto -x -k cmd-*.zip . && codesign --verify --deep --strict cmd.app
spctl --assess --type execute -vv cmd.app                  # accepted, source=Notarized Developer ID
xcrun stapler validate cmd.app
spctl -a -t open --context context:primary-signature -vv cmd-*.dmg
```

**Without `latest-mac.yml` and `latest.yml`, installed apps can't update.** Check that both are
there and that their `version` matches.

## Rules

- **Never delete or move a published tag or release**, even a broken one. Installed apps and people
  may already have it. Fix forward with the next patch.
- **Releases must be Developer ID signed.** Squirrel.Mac only installs an update whose signature
  matches the running app's, so an ad-hoc signed release strands everyone who installs it. If the
  signing secrets are missing, CI warns ("ad-hoc signed") and still publishes. Treat that release as
  broken.
- Don't hand out a `curl … | sh` or `irm … | iex` command for a new `scripts/install.sh` or
  `install.ps1` before it's pushed to master.
- Windows builds are unsigned for now (SmartScreen warns about a downloaded installer). Updates
  still work.

## When it fails

| Symptom | Cause / fix |
|---|---|
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
