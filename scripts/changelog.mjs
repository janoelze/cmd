// CHANGELOG.md for releases (format and style: .claude/skills/changelog/SKILL.md).
//   node scripts/changelog.mjs check [version]   lint the file; with a version, require its section
//   node scripts/changelog.mjs notes <version>   print that release's notes (the GitHub release body)
// release.mjs runs `check` before tagging, CI runs both on a tag.
import fs from "node:fs";
import { lintChangelog, parseChangelog, releaseNotes } from "../apps/desktop/src/shared/changelog.ts";

const file = new URL("../CHANGELOG.md", import.meta.url);
const [cmd, arg] = process.argv.slice(2);
const version = arg?.replace(/^v/, "");
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : fail("CHANGELOG.md is missing");
const release = version && parseChangelog(text).find((r) => r.version === version);
const missing = `CHANGELOG.md has no section for ${version}. Write it first: the changelog skill (.claude/skills/changelog/SKILL.md) says how.`;

if (cmd === "check") {
  const problems = lintChangelog(text);
  if (problems.length) fail(problems.join("\n"));
  if (version && !release) fail(missing);
  console.log(version ? `CHANGELOG.md: ${version} is there and the file is clean` : "CHANGELOG.md is clean");
} else if (cmd === "notes" && version) {
  if (!release) fail(missing);
  process.stdout.write(releaseNotes(release));
} else fail("usage: node scripts/changelog.mjs check [version] | notes <version>");
