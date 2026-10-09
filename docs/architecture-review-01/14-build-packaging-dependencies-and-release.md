# 14 Build, packaging, dependencies and release

**Score: 6/10** · reviewed 2026-10-10 against commit ddb7832 · scope: how source becomes a shipped app (workspace layout, manifests, tsconfigs, postinstall and native helpers, runtime staging, electron-vite and electron-builder configs, CI workflows, release and install scripts, updater/packaging interplay)

| Dimension | Score | One line |
|---|---|---|
| Structure & boundaries | 7/10 | The package graph is clean and acyclic today, but written down nowhere and enforced by nothing |
| Correctness & robustness | 5/10 | Dev, tests and release run three different Node binaries; a tag build without secrets publishes an ad-hoc release |
| Performance | 6/10 | 3,063 files / 41 MB of runtime per update; the core's import takes 95 ms where a bundle takes 35 ms |
| Security | 6/10 | Signing, notarization and verification are thorough; workflow-wide write token, actions pinned by tag (fuses: see doc 09) |
| Testability & tests | 7/10 | `check-runtime.mjs`, `e2e/packaged.mjs` and the signature/staple checks gate every build |
| Extensibility | 6/10 | Adding a main-process or core dependency needs edits in two or three hand-kept lists |
| Code health | 7/10 | Short, well-commented scripts; a placeholder string in `pnpm-workspace.yaml`, stale Windows docs |

## What this system is

A pnpm workspace (`pnpm-workspace.yaml`, pnpm 11.5.1) of six packages (`protocol`, `remote-crypto`, `core`, `cli`, `ui`, `tours`) and three apps (`desktop`, `web`, `relay`). Core, CLI and protocol have no build step: they run as `.ts` under Node's type stripping, which `tsconfig.base.json` backs with `erasableSyntaxOnly`, `verbatimModuleSyntax` and `allowImportingTsExtensions`. There are no project references: one root `tsconfig.json` checks `packages/*` plus the relay, and `ui`, `desktop` and `web` have their own (root `tsc` takes 2.2 s, desktop 2.5 s). `scripts/postinstall.mjs` (80 lines) chmods node-pty's `spawn-helper`, compiles three native helpers with the system toolchain (`packages/core/native/procinfo.c` 222 lines, `apps/desktop/native/sfsymbols.swift` 138 and `notifications.m` 119; arm64 only, no `-arch`), fetches Electron if pnpm skipped its script, and rebrands the dev `Electron.app` in place. Every failure there is a `console.warn`.

The desktop app is built by electron-vite (`electron.vite.config.ts`, 106 lines): main is bundled unminified with `@cmd/protocol`, `@cmd/ui`, lucide, electron-updater, butterchurn and Strudel inlined (the last three as lazy `?raw` chunks); the renderer is minified with no sourcemaps (index chunk 1.3 MB; PDF, Text, Jam views and the 100+ CodeMirror language modes are lazy chunks). `scripts/stage-runtime.mjs` (129 lines) copies the core, protocol, remote-crypto and CLI sources plus a flat copy of their npm dependencies into `apps/desktop/.runtime`, which `electron-builder.yml` (62 lines) ships as `Contents/Resources/runtime`; the packaged app runs it with Electron's own Node (`ELECTRON_RUN_AS_NODE`) from a per-build copy under `$CMD_HOME/runtime/<build>` (doc 01). `scripts/check-runtime.mjs` (61 lines) boots the staged core once in CI.

`.github/workflows/build.yml` (291 lines) typechecks, tests, builds, stages, packages and verifies on `macos-latest` for every push and PR. On a `v*` tag it signs with Developer ID, notarizes the dmg once, staples dmg and app, rebuilds the update zip from the stapled app (`--prepackaged`) and publishes a GitHub release that electron-updater (`apps/desktop/src/main/updater.ts`, 190 lines) reads through `latest-mac.yml`. `scripts/release.mjs` (50 lines) bumps the version, tags and pushes after `scripts/changelog.mjs check`. `scripts/install.sh` installs the latest arm64 zip, and `install.ps1` the Windows installer, whose CI job is `if: false`. `website.yml` and `remote.yml` rsync the PHP site and the relay/web client to one Uberspace host with a shared SSH deploy key. Design docs: DEVELOPMENT.md ("Packaging and releases", "Updates", "Signing and notarization"), docs/14-performance.md (core boot numbers and the "pre-bundled core" option, line 64), the release skill.

Answers to this review's questions, in brief:
- **Layering.** The measured graph is `protocol`, `remote-crypto` (leaves) ← `core` ← `cli`; `protocol` ← `relay`; `protocol`, `remote-crypto` ← `web`; `protocol`, `ui` ← `desktop`. Nothing in any `src/` imports another package by relative path (`grep` count 0). Desktop never imports `@cmd/core`. Deviations are listed in AR1-14-07.
- **Native ABI.** node-pty 1.2.0-beta.15 is N-API (`node-addon-api`) with prebuilds, so one `pty.node` serves system Node 22 (ABI 127) and Electron 44.5.1's Node 24.21.0 (ABI 149). Nothing is compiled against either ABI. The helpers are plain executables or a `-undefined dynamic_lookup` bundle.
- **Release chain.** It has one runner type, one Apple account and one GitHub repo, and installed apps follow `latest` with no rollback. A hotfix is `git checkout -b fix v0.23.0`, commit, `pnpm release patch` (it pushes whatever branch is checked out), then 5–8 minutes of CI plus up to 40 minutes of notarization. The usage-stats key and Discord webhooks are baked in at build time (webhooks: doc 09; key: documented as spam-deterrent only).
- **Heavy dependencies.** butterchurn (850 KB), Strudel (661 KB) and electron-updater (570 KB) are lazy chunks in main. pdf.js, CodeMirror language data and the Jam view are lazy in the renderer. xterm is 6.0.0 in core (`@xterm/headless`) and desktop alike. The lockfile has 520 packages, and the only real duplicates are two Vites (7.3.6 for electron-vite, 8.3.2 for vitest 5) and two esbuilds.
- **Dev loop.** The renderer gets HMR. Main and preload restart through electron-vite. The core is restarted by the build-hash check (doc 01). A new worktree costs `pnpm install` from the store, about 2 s of native compiles and a 309 MB Electron copy (AR1-14-09).

## What is good

- **The signing chain is careful and verified.** One notarization (the dmg), staple both, rebuild the update zip from the stapled app so `latest-mac.yml` hashes match, then `codesign --verify --deep --strict`, `spctl` and `stapler validate` before anything uploads (`build.yml:134-173`). Every shipped Mach-O, `procinfo` and `pty.node` included, carries the Developer ID signature with hardened runtime (checked on `/Applications/cmd.app`).
- **Secrets are scoped to tag builds.** Every secret is gated with `startsWith(github.ref, 'refs/tags/v') && secrets.X || ''` (`build.yml:73-95`), and the deploy host key is pinned (`remote.yml`, `website.yml`).
- **The packaged runtime is tested as shipped.** `check-runtime.mjs` boots the staged copy, and `e2e/packaged.mjs` opens the packaged app and a terminal. This catches the "dependency missing from the runtime" class that source e2e can't see.
- **The changelog gate runs three times**: `release.mjs`, CI before the long build, and `pnpm test`. Notes are generated from the same file the app's What's New shows.
- **Lazy loading is done right where it matters.** Visualizer, Jam, PDF, editors and the AI SDK (absent from the core's static import graph: 243 modules load, none from `ai`) load on use.
- **Dependency hygiene is good.** A knip-style sweep finds one unused dependency (AR1-14-07), one undeclared optional import, and no version skew between core and desktop.
- **Type stripping keeps stack traces exact.** Node replaces types with whitespace, so a core crash report points at the real `.ts` line and column with no sourcemap. Any bundling (AR1-14-03) must keep this.

## Issues

### AR1-14-01 · Run dev, tests and release on one Node major: Electron's

- **Status:** open
- **Severity:** high
- **Effort:** S (< ½ day)
- **Where:** `package.json:8-12`, `package.json:20` (`devDependencies["@types/node"]`), `apps/desktop/src/main/index.ts:329-334`, `.github/workflows/build.yml:55-58`, `CLAUDE.md:32`

**Problem.** Three Node binaries run the same TypeScript: the release core runs on Electron 44's Node 24.21, CI runs `pnpm test` and `check-runtime.mjs` on setup-node's latest 24.x, and developers run `pnpm core`, `pnpm cmd` and `pnpm test` on whatever system `node` they have. `engines` says `>=22.18`, so that is 22 here. `main/index.ts` already documents a Node 22 bug that breaks the core: "the system Node 22 resolves the first symlinked package wrong after any stat of a Unix socket … lazily loaded pnpm packages like the AI SDK then can't find their dependencies. Node 24 doesn't." The app works around it by spawning the dev core with Electron's Node, but `pnpm core` (the documented way to run a core) still uses system `node` and so has the bug. `@types/node` is `^24.9.0`, so Node 24-only APIs typecheck and then throw under `pnpm core`, `pnpm cmd` and local tests on Node 22.

**Evidence.** On this machine: `node -v` → v22.23.3, `ELECTRON_RUN_AS_NODE=1 Electron -p process.versions` → node 24.21.0, modules 149. `package.json:12`: `"core": "node --no-warnings packages/core/src/main.ts --instance=dev"`. `build.yml:57`: `node-version: 24`. There is no `.node-version` or `.nvmrc`, and no `engine-strict`.

**Proposal.** Make Electron's Node major the one supported dev runtime. Add `.node-version` (`24`) and set `engines.node` to `>=24.11` with `engine-strict=true` in `.npmrc`. Point setup-node at `node-version-file: .node-version`. Pin `@types/node` to `~24.x` and keep it in step with Electron, then add a test asserting that `electron/package.json`'s Node major (from `electron/dist/version` or `process.versions` via a one-line spawn) equals `.node-version`. Update `CLAUDE.md:32` and DEVELOPMENT.md ("Node ≥ 22.18"). Rejected alternative: run `pnpm core` and `pnpm cmd` under `ELECTRON_RUN_AS_NODE`. It matches the release exactly, but it makes the CLI depend on an Electron install and slows every `pnpm cmd`.

**Success criteria.**
- [ ] `.node-version` exists; `build.yml` and `remote.yml` read it; `grep -rn "22.18" CLAUDE.md DEVELOPMENT.md package.json` returns nothing.
- [ ] `pnpm install` on Node 22 fails with an engine error.
- [ ] A vitest test fails when Electron's bundled Node major differs from `.node-version`.
- [ ] The workaround comment at `main/index.ts:329-332` still says why Electron's Node is used, without claiming system Node is supported.

### AR1-14-02 · Make a tag build fail rather than publish a release users can't update to

- **Status:** open
- **Severity:** high
- **Effort:** S (< ½ day)
- **Where:** `.github/workflows/build.yml:125-131`, `.github/workflows/build.yml:132-133`, `apps/desktop/electron.vite.config.ts:55-60`, `apps/desktop/electron.vite.config.ts:94`, `scripts/release.mjs:41-49`

**Problem.** If the signing secrets go missing on a tag (an expired or rotated certificate, a renamed secret), CI ad-hoc signs, prints a `::warning::` and publishes the release as `latest` anyway. Squirrel.Mac only installs an update whose signature satisfies the running app's designated requirement (DEVELOPMENT.md, "Updates"), so every Developer ID install downloads the update, fails to apply it and stays behind, while `install.sh` users get an app Gatekeeper blocks. The version also has two sources. CI sets the app's version from the tag (`-c.extraMetadata.version`), but `__APP_VERSION__` (What's New) and the usage-stats key (`usageKey()`, HMAC over `cmd-usage:${version}`) read `apps/desktop/package.json`. The release skill tells you to tag prereleases directly without a bump, so a prerelease shows the previous version's What's New and signs usage batches with the previous version's key, which the server rejects with 401. There is no rollback path: electron-updater follows the newest non-prerelease, so a bad release can only be replaced by a higher version.

**Evidence.** `build.yml:130`: `[ "$IS_TAG" = true ] && echo "::warning::No signing secrets: this release is ad-hoc signed, not notarized"`, and the job continues. `electron.vite.config.ts:58` reads `package.json`'s version, and `:94` does the same for `__APP_VERSION__`. The skill's prerelease instructions say "CI takes the version from the tag, so no bump commit is needed".

**Proposal.** In the Package step, `exit 1` on a tag when `MAC_CERT_P12_BASE64` is unset. Before the build, add a step that fails when a non-prerelease tag differs from `apps/desktop/package.json`'s version. For prereleases, write the tag's version into `package.json` in the CI workspace before `pnpm build`, so `__APP_VERSION__`, the usage key and `extraMetadata` agree. A `version.json` produced by one step and read by the vite config would also work. Write the rollback recipe into the release skill: `pnpm release patch` from the last good tag's tree (`git checkout -b rollback vX.Y.Z`, then revert). Consider a certificate-expiry check (`security find-certificate -p | openssl x509 -enddate`) that warns 30 days ahead.

**Success criteria.**
- [ ] A tag pushed with the signing secrets removed fails the `mac` job before `gh release create` runs (demonstrated on a `-test` prerelease in a fork, or by a dry-run step).
- [ ] `grep -n "::warning::No signing secrets" .github/workflows/build.yml` returns nothing.
- [ ] A step compares the tag with `apps/desktop/package.json` and fails on a mismatch for non-prerelease tags.
- [ ] A prerelease build's `app.getVersion()`, `__APP_VERSION__` and usage key all use the tag's version (asserted in `e2e/packaged.mjs` or a unit test of the version helper).
- [ ] The release skill has a "Roll back" section.

### AR1-14-03 · Bundle each Node entry point at staging time instead of shipping a source tree

- **Status:** open
- **Severity:** medium
- **Effort:** L (> 2 days)
- **Where:** `scripts/stage-runtime.mjs:15-127`, `apps/desktop/electron-builder.yml:16-18`, `packages/core/src/main.ts`, `packages/core/src/terminals/host-main.ts`, `packages/core/src/sqlite/service.ts:80`, `packages/core/src/agents/hooks.ts:43`
- **Depends on:** AR1-14-04 (as the interim step), AR1-01-02 (`build-id` file)

**Problem.** The release ships the dev layout: TypeScript sources, a flattened `node_modules` and shims so Node will load `.ts` from outside `node_modules`. That makes 3,063 files and 41 MB. Every update copies all of it per file into `$CMD_HOME/runtime/<build>` (643 ms on the main thread, doc 01 AR1-01-02), and the core's cold start pays to resolve and strip 144 own modules and 84 dependency modules. docs/14 (line 58) measured 124 ms of import, about 50 ms of it stripping, which Node's compile cache doesn't cover, and line 64 already lists "a pre-bundled core in packaged builds" as a win nobody has taken. Type stripping itself is fine, but as a shipping format the source tree costs time, file count and a staging script that re-implements `pnpm deploy`.

**Evidence.** Measured during this review with esbuild 0.25 (`--bundle --platform=node --format=esm`, externals `node-pty`, `@vscode/ripgrep`, `playwright`): `core.ts` builds into one 4.1 MB file (2.2 MB minified) from 350 inputs, in 0.15 s. Importing it under the shipped app's Node (`ELECTRON_RUN_AS_NODE=1 /Applications/cmd.app/Contents/MacOS/cmd`) takes 34–36 ms, against 93–137 ms for `core.ts` from `Contents/Resources/runtime`, even though the bundle also pulls in the AI SDK eagerly. The bundle first failed with `ENOENT … magic/prompt/preview-themes.json`: 23 `import.meta.dirname`/`import.meta.url` sites in core and protocol locate assets relative to the source file. The shell integration (`packages/core/shell/`), `widget-runtime/` (run by Deno), Magic's prompt files and `jam/reference.md` are such assets.

**Proposal.** Keep "no build step" for development, and add a build step for packaging only. `scripts/stage-runtime.mjs` becomes an esbuild script with four ESM entry points (core `main.ts`, PTY host `host-main.ts`, the SQLite worker, the CLI `main.ts`), with `splitting: true` so the four share chunks and the AI SDK stays a lazy chunk. It keeps the `createRequire` banner, `keepNames`, no minification (readable stacks without maps) or `sourcemap: "linked"` with `--enable-source-maps` on the spawn lines, `external: ["node-pty", "@vscode/ripgrep-*"]`, and copies only those two packages' runtime files. First move the 23 asset lookups behind one `assetPath(rel)` helper in `@cmd/protocol/node`, which resolves from the runtime root (`process.env.CMD_RUNTIME_ROOT` or the repo root in source), and copy the asset folders next to the bundle. Write `build-id` at staging (AR1-01-02) so nothing hashes sources at runtime. The runtime copy after an update stays (doc 01 explains why) but drops to about 15 files. Prior art: VS Code ships its server and pty host as bundled entry points (00-research.md §6, §8), and the relay already builds this way (`apps/relay/package.json`, esbuild).

**Success criteria.**
- [ ] `find apps/desktop/.runtime -type f | wc -l` < 100 and `du -sh` < 12 MB after `node scripts/stage-runtime.mjs`.
- [ ] Importing the staged core entry under Electron's Node takes < 50 ms (median of 5, measured by a script in `scripts/perf/`).
- [ ] `grep -rn "import.meta.dirname" packages/core/src packages/protocol/src` returns only the `assetPath` helper.
- [ ] `scripts/check-runtime.mjs` and `e2e/packaged.mjs` pass. A thrown error in the packaged core logs a stack with `.ts` file names and correct lines.
- [ ] `pnpm core` and `pnpm dev` still run from source (no build before a dev run).

### AR1-14-04 · Prune the staged runtime: types, maps, dependency sources, other architectures

- **Status:** open
- **Severity:** medium
- **Effort:** S (< ½ day)
- **Where:** `scripts/stage-runtime.mjs:100-127`

**Problem.** `stageDeps` copies each dependency's whole package directory. Half of what ships is never executed: type declarations, sourcemaps, the TypeScript `src/` the AI SDK and zod publish, READMEs and changelogs, `node-addon-api` (a build-time header package), and node-pty's `darwin-x64` prebuild in an app that only runs on arm64 (the filter at line 124 keeps every `darwin-*`). Each of those files is signed, notarized, zipped and copied again per update.

**Evidence.** In `/Applications/cmd.app/Contents/Resources/runtime` (41 MB, 3,063 files): 2,800 files are under `packages/core/node_modules`. `.d.ts`/`.d.cts`/`.d.mts`/`.map` files total 11 MB, `*/src/*.ts` inside dependencies 9.6 MB (1,310 files), 97 README/markdown files, `node-addon-api` 432 KB, and `prebuilds/` holds `darwin-arm64` and `darwin-x64`. The largest packages: `ai` 9.1 MB, `@ai-sdk/*` 9.5 MB, `zod` 8.0 MB.

**Proposal.** Give the `fs.cpSync` at line 104 a filter that drops `*.d.ts`, `*.d.cts`, `*.d.mts`, `*.map`, `*.md` (license files stay), and `src/`, `docs/`, `test/` directories of packages whose `exports` point into `dist/`. Skip `node-addon-api` (no runtime import: `grep -rn "node-addon-api" …/node-pty/lib` is empty). Keep only the `${process.platform}-${process.arch}` prebuild. This is the interim step for AR1-14-03, and it is worth doing even if that never lands.

**Success criteria.**
- [ ] After staging, `find apps/desktop/.runtime -name '*.d.ts' -o -name '*.map' | wc -l` is 0.
- [ ] `du -sh apps/desktop/.runtime` < 22 MB and the file count < 1,400.
- [ ] `ls apps/desktop/.runtime/packages/core/node_modules/node-pty/prebuilds` lists one directory.
- [ ] `scripts/check-runtime.mjs` passes, and a Magic widget build (which uses the AI SDK) works in `e2e/packaged.mjs` or by hand on a `pnpm dist` build.

### AR1-14-05 · Keep renderer sourcemaps per release so crash stacks can be read

- **Status:** open
- **Severity:** medium
- **Effort:** M (1–2 days)
- **Where:** `apps/desktop/electron.vite.config.ts:93-104`, `.github/workflows/build.yml:179-187`, `apps/desktop/src/main/crash.ts`

**Problem.** The renderer is minified (`minify: true`), and no build writes a sourcemap. Crash reports include "uncaught errors in the app's pages" (DEVELOPMENT.md), so a renderer stack arrives as `index-B2xhurB7.js:1:834211`, a column in a 1.3 MB single-line file that nobody can map back once the release's build is gone. Main is unminified and the core is exact source, so the renderer is the one process whose crashes can't be read, and it holds the most code.

**Evidence.** `ls out/renderer/assets/*.map out/main/*.map` → none. `index-B2xhurB7.js` is 1,295,170 bytes. No `sourcemap` key appears anywhere in `electron.vite.config.ts`.

**Proposal.** Set `renderer.build.sourcemap: "hidden"`, which writes maps without the `//# sourceMappingURL` comment. electron-builder's `files` excludes `out/**/*.map` from the asar, and CI uploads the maps as a `cmd-sourcemaps-<version>` artifact attached to the GitHub release (or kept 90 days). Add `scripts/symbolicate.mjs <crash.json>`, which downloads that version's maps and rewrites the stack with `source-map` (already a transitive dependency). The triage skill points at it. Prior art: Sentry's and VS Code's "upload maps, don't ship them" pattern.

**Success criteria.**
- [ ] `pnpm build` produces `out/renderer/assets/*.js.map`, and `npx @electron/asar list app.asar | grep '\.map$'` is empty.
- [ ] A tag build attaches or uploads the maps; `gh release view vX.Y.Z` or the run's artifacts list them.
- [ ] `node scripts/symbolicate.mjs <a renderer crash JSON>` prints `.tsx` file names and lines.
- [ ] The triage skill mentions the script.

### AR1-14-06 · Narrow the workflow token and pin third-party actions

- **Status:** open
- **Severity:** medium
- **Effort:** S (< ½ day)
- **Where:** `.github/workflows/build.yml:36-37`, `.github/workflows/build.yml:51-58`, `.github/workflows/website.yml:24-33`, `.github/workflows/remote.yml:26-33`

**Problem.** `permissions: contents: write` is set for the whole workflow. Every `mac` job on every push to master runs `pnpm install` with lifecycle scripts approved for node-pty, electron and esbuild, plus cmd's own postinstall, all while holding a token that can push tags and create releases. Only the `release` job needs write access. All actions are pinned by mutable tag (`@v4`, `@v5`). That includes the third-party `shivammathur/setup-php@v2` in `website.yml`, which runs in the same job that writes the Uberspace SSH deploy key to disk, the key that also deploys the relay. A compromised action tag, or a dependency's install script, gets a write token or the deploy key.

**Evidence.** `build.yml:36-37` is workflow-level. `grep -c "@v[0-9]" .github/workflows/*.yml` shows tags only, no SHAs. `website.yml:24-28` runs `setup-php@v2` before the "SSH" step, in the same job.

**Proposal.** Set `permissions: contents: read` at the top, and `contents: write` on `release` only. Pin every action to a full commit SHA with the tag in a comment, and let Dependabot (`.github/dependabot.yml`, `package-ecosystem: github-actions`) bump them. In `website.yml`, write the SSH key only in the deploy step itself (`env` plus `ssh -i` on the command) or use `webfactory/ssh-agent` pinned by SHA. Give the website and relay separate deploy keys restricted on the host (`command=`/`from=` in `authorized_keys`) so one leak doesn't expose both.

**Success criteria.**
- [ ] `grep -n "contents: write" .github/workflows/build.yml` matches only under the `release` job.
- [ ] `grep -E "uses: [^@]+@v[0-9]" .github/workflows/*.yml` returns nothing.
- [ ] `.github/dependabot.yml` covers `github-actions`.
- [ ] website and relay deploys use different secrets.

### AR1-14-07 · Write down the package graph and fix the five places that bend it

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `packages/core/package.json` (devDependencies), `packages/core/src/widgets/preview.ts:146-152`, `apps/desktop/package.json` (`@codemirror/theme-one-dark`), `packages/cli/src/main.ts:11-13`, `packages/core/test/remote.test.ts`, `apps/desktop/src/renderer/src/keybindings.ts:6`

**Problem.** The intended graph is respected today, but only by habit. The bends:
1. Core imports `playwright` (dynamically, with a fallback) without declaring it. It resolves through the root `devDependencies`, so the packaged core silently never has it.
2. Core declares five `@strudel/*` devDependencies that only `scripts/jam/` uses.
3. Desktop declares `@codemirror/theme-one-dark`, which nothing imports (`@cmd/ui` has its own `one-dark.ts`).
4. The CLI statically imports `magic.ts`, `widget.ts` and `agents.ts`, so `cmd --version` loads 36 core modules (73 in total, 110 ms). Hook commands and every `cmd` typed in a pane pay this.
5. A core test imports `apps/relay/src/relay.ts`, a package reaching up into an app. Four renderer files import types from `main/` (the preload's case is doc 09).

Doc 13 owns the gate. This issue defines what the gate enforces.

**Evidence.** A sweep of each package's bare imports against its `package.json`: undeclared `playwright` in core; unused `@codemirror/theme-one-dark` in desktop; no others. The CLI's module count was measured with a `module.registerHooks` load counter: `{"total":73,"own":61,"core":36}`. `grep -rn "@strudel" packages/core/src` matches only a markdown file.

**Proposal.** Write the graph as dependency-cruiser rules (doc 13 wires them into `pnpm test`):
- `protocol` and `remote-crypto` import no workspace package.
- `core` imports only those two.
- `cli` imports `protocol`, `remote-crypto` and the declared `@cmd/core` subpath exports, never `@cmd/core/src/*`.
- `ui` imports no workspace package.
- `desktop/renderer` imports `protocol`, `ui` and `desktop/shared`, never `desktop/main` or `node:*`.
- `apps/*` are never imported from `packages/*` (tests included; move the relay test to `apps/relay/test`).
- No `src/` import crosses a package by relative path.

Then: declare `playwright` as an optional peer dependency of core (`peerDependenciesMeta`) or pass the previewer in from the CLI; move `@strudel/*` to the root `devDependencies` next to `scripts/jam`; drop `@codemirror/theme-one-dark`; make the CLI's heavy subcommands `await import()` on dispatch; move the four shared types to `desktop/src/shared/`. On the question "should `@cmd/cli` depend on `@cmd/core`": yes, for offline commands (Magic builds, fixtures), but only through subpath exports and lazily.

**Success criteria.**
- [ ] A dependency-cruiser (or equivalent) config with the rules above exists and passes.
- [ ] `cmd --version` loads no file under `packages/core/` (same load counter).
- [ ] `grep -n "strudel" packages/core/package.json` and `grep -n "theme-one-dark" apps/desktop/package.json` return nothing.
- [ ] `grep -rln "from \"\.\./.*main/" apps/desktop/src/renderer` returns nothing.

### AR1-14-08 · Decide what Windows is, and make the docs and installer say it

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `.github/workflows/build.yml:189-191`, `DEVELOPMENT.md:85`, `scripts/install.ps1:10-12`, `scripts/install.sh:9`, `apps/desktop/electron-builder.yml:45-56`

**Problem.** The Windows job is `if: false` and the release job `needs: [mac]` only, so no release carries a Windows installer. Yet DEVELOPMENT.md says "Windows builds (x64) come from the same tag", `install.sh` tells non-Mac users to run `install.ps1`, and `install.ps1` fetches `releases/latest`, finds no `*-win-x64-setup.exe` and throws "no Windows installer in v0.23.0". Meanwhile Windows code paths (`stage-runtime.mjs`, 11 `win32` branches in core and desktop, the NSIS config) keep working only by chance.

**Evidence.** `build.yml:190`: `if: false # disabled for now`. `build.yml:260`: `needs: [mac]`. A `cmd-windows` worktree exists, so the work is in flight.

**Proposal.** Until Windows ships: DEVELOPMENT.md says Windows is not released, and why. `install.sh` stops pointing at `install.ps1`. `install.ps1` prints "cmd doesn't ship for Windows yet" when the release has no installer. The Windows job runs on `workflow_dispatch` and a weekly `schedule`, non-blocking (`continue-on-error`), so the code paths stay honest. When it ships, add it back to `needs` and set up Authenticode signing, since SmartScreen will flag an unsigned installer once it is downloaded by browser.

**Success criteria.**
- [ ] DEVELOPMENT.md's Windows paragraph matches `build.yml`.
- [ ] `install.ps1` against a release without a Windows asset exits with a sentence a person understands, not a stack trace.
- [ ] The Windows job runs at least weekly and its result is visible in Actions.

### AR1-14-09 · Make a new worktree cheap: share Electron and the native helpers, and fail loudly

- **Status:** open
- **Severity:** low
- **Effort:** M (1–2 days)
- **Where:** `scripts/postinstall.mjs:10-79`, `pnpm-workspace.yaml:9`

**Problem.** The worktree-per-task flow (CLAUDE.md) makes `pnpm install` a frequent operation. The pnpm store makes JavaScript packages cheap, but each worktree also unpacks its own 309 MB Electron and rebrands that `Electron.app` in place. It recompiles three native helpers (clang 0.45 s, swiftc 1.5 s), which are identical across worktrees unless their source changed. Every postinstall failure is a warning that scrolls past. Offline or on a machine without Xcode tools, you learn about it later, when `stage-runtime.mjs` throws "procinfo missing" or agent detection quietly falls back to process names. `pnpm-workspace.yaml` also contains pnpm's prompt text as a value: `'@vscode/ripgrep': set this to true or false`.

**Evidence.** `du -sh */node_modules/.pnpm/electron@*/node_modules/electron/dist` across the 7 worktrees: 309–310 MB each, about 2.2 GB in all. `postinstall.mjs` has five `try … catch → console.warn` blocks. `pnpm ignored-builds` shows the placeholder isn't treated as a decision.

**Proposal.** (1) Native helpers: hash each source together with the compiler version, and build into `~/Library/Caches/cmd/native/<hash>/`, then copy or clone from there. A second worktree pays nothing. (2) Electron: keep one branded `Electron.app` per Electron version in `~/Library/Caches/cmd/electron/<version>/` and point electron-vite at it with `ELECTRON_OVERRIDE_DIST_PATH`, or let the worktree's `dist` be an APFS clone (`cp -c`) of it. (3) Make the postinstall print one summary at the end ("2 of 4 native helpers missing: …, run `xcode-select --install`") and exit non-zero under `CI`. (4) Replace the placeholder with `'@vscode/ripgrep': false` (the binary comes from its optional per-platform package, which has no build script).

**Success criteria.**
- [ ] A second `git worktree add` plus `pnpm install` doesn't run `clang` or `swiftc` (logged "cached").
- [ ] `du -sh` of a new worktree's Electron `dist` reports a clone or a link, not a fresh 309 MB extraction (or `ELECTRON_OVERRIDE_DIST_PATH` is set by `pnpm dev`).
- [ ] `CI=1 node scripts/postinstall.mjs` with `/usr/bin/clang` unavailable exits non-zero.
- [ ] `grep -n "set this to" pnpm-workspace.yaml` returns nothing.

### AR1-14-10 · Make `check-runtime.mjs` talk only to the core it started

- **Status:** open
- **Severity:** low
- **Effort:** S (< ½ day)
- **Where:** `scripts/check-runtime.mjs:15-35`, `packages/protocol/src/instance.ts:132`

**Problem.** The script starts the staged core with a throwaway `CMD_HOME` and then calls `connect()`, which prefers `$CMD_SOCKET`. Run from a cmd terminal (where every pane has `CMD_SOCKET`), it talks to the installed app's core, so it passes even when the staged core crashed at start. Found while reviewing AR1-15-01, whose author had to run it with `env -u CMD_SOCKET` to get a real answer.

**Evidence.** `instance.ts:132`: "Where a client connects: $CMD_SOCKET (the pane's own core), else this instance's core". `check-runtime.mjs` sets `CMD_HOME` but leaves `CMD_SOCKET`, and passes `process.env` to the spawned core too.

**Proposal.** `delete process.env.CMD_SOCKET` (and the other pane-context variables `enterInstance` drops) before importing `node.ts`, connect to the socket path derived from the throwaway home explicitly, and assert `core.hello.pid` equals the spawned child's pid.

**Success criteria.**
- [ ] With `CMD_SOCKET` pointing at a live core and the staged `main.ts` made to throw, the script exits non-zero.
- [ ] The script checks `hello.pid === core.pid`.

## Course corrections

1. **One Node, and a release that fails closed** (AR1-14-01, AR1-14-02). Both are small, and both remove a way the shipped app or the dev loop silently differs from what was tested.
2. **Shrink, then bundle, the runtime** (AR1-14-04 now, AR1-14-03 next, together with doc 01's AR1-01-02). This is the target build architecture: development runs source with type stripping and no build step, and packaging produces one esbuild bundle per Node entry (core, PTY host, SQLite worker, CLI) with shared chunks, assets copied next to it, node-pty and ripgrep as the only `node_modules`, and a `build-id` file. The result is about 15 files instead of 3,063, the post-update copy drops from about 640 ms to tens of ms, the core imports about 60 ms faster, and the shims and `stageDeps` disappear.
3. **Make crashes readable and the pipeline tight** (AR1-14-05, AR1-14-06): hidden renderer sourcemaps per release, a read-only token, SHA-pinned actions.
4. **Write the graph down** (AR1-14-07) so doc 13's gate has rules to enforce before a seventh package arrives.

## Quick wins

AR1-14-01, AR1-14-02, AR1-14-04, AR1-14-06, AR1-14-07, AR1-14-08, AR1-14-10, and the `pnpm-workspace.yaml` placeholder from AR1-14-09.
