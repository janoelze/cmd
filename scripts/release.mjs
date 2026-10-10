// Cuts a release: bumps apps/desktop's version, commits, tags `v<version>` and
// pushes. CI (.github/workflows/build.yml) builds the tag and publishes the
// GitHub release with the .dmg and .zip; a version with a `-` is a prerelease.
// Refuses a release whose CHANGELOG.md section is missing or fails the lint.
//   node scripts/release.mjs 0.2.0
//   node scripts/release.mjs patch|minor|major
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { compareVersions } from "../apps/desktop/src/shared/changelog.ts";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const pkgPath = new URL("../apps/desktop/package.json", import.meta.url);
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

const arg = process.argv[2];
if (!arg) fail("usage: pnpm release <version|patch|minor|major>");
const bump = (v, part) => {
  const [major, minor, patch] = v.split("-")[0].split(".").map(Number);
  if (part === "major") return `${major + 1}.0.0`;
  if (part === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};
const version = ["patch", "minor", "major"].includes(arg) ? bump(pkg.version, arg) : arg.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`not a semver version: ${version}`);
const tag = `v${version}`;

if (git("status", "--porcelain")) fail("working tree is not clean; commit or stash first");
if (git("tag", "--list", tag)) fail(`tag ${tag} already exists`);
// Installed apps only update to a higher version, so even a rollback is a new, higher release.
const newest = git("tag", "--list", "v*").split("\n").map((t) => t.slice(1)).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort(compareVersions).at(-1);
if (newest && compareVersions(version, newest) <= 0 && !version.includes("-")) fail(`not releasing ${tag}: v${newest} is out already, and installed apps only update to a higher version`);
// Users see this section in What's New, so a release without one doesn't ship (CI checks again).
if (!version.includes("-")) {
  try {
    execFileSync(process.execPath, [new URL("./changelog.mjs", import.meta.url).pathname, "check", version], { stdio: "inherit" });
  } catch {
    fail(`not releasing ${tag}: fix CHANGELOG.md first`);
  }
}
const branch = git("rev-parse", "--abbrev-ref", "HEAD");

if (pkg.version !== version) {
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  git("commit", "-q", "-m", `Release ${tag}`, "--", "apps/desktop/package.json");
}
git("tag", "-a", tag, "-m", tag);
execFileSync("git", ["push", "--atomic", "origin", branch, tag], { stdio: "inherit" });
console.log(`pushed ${tag}; CI publishes the release: gh run watch, then gh release view ${tag}`);
