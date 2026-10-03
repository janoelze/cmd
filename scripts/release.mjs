// Cuts a release: bumps apps/desktop's version, commits, tags `v<version>` and
// pushes. CI (.github/workflows/build.yml) builds the tag and publishes the
// GitHub release with the .dmg and .zip; a version with a `-` is a prerelease.
//   node scripts/release.mjs 0.2.0
//   node scripts/release.mjs patch|minor|major
import fs from "node:fs";
import { execFileSync } from "node:child_process";

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
const branch = git("rev-parse", "--abbrev-ref", "HEAD");

if (pkg.version !== version) {
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  git("commit", "-q", "-m", `Release ${tag}`, "--", "apps/desktop/package.json");
}
git("tag", "-a", tag, "-m", tag);
execFileSync("git", ["push", "--atomic", "origin", branch, tag], { stdio: "inherit" });
console.log(`pushed ${tag}; CI publishes the release: gh run watch, then gh release view ${tag}`);
