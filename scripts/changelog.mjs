// CHANGELOG.md for releases (format and style: .claude/skills/changelog/SKILL.md).
//   node scripts/changelog.mjs check [version]   lint the file; with a version, require its section
//   node scripts/changelog.mjs notes <version>   print that release's notes (the GitHub release body)
//   node scripts/changelog.mjs announce <version> post them to Discord's #whats-new through $CMD_RELEASES_WEBHOOK
//                                                 (--dry-run prints the webhook body instead)
// release.mjs runs `check` before tagging, CI runs all three on a tag.
import fs from "node:fs";
import { discordAnnouncement, lintChangelog, parseChangelog, releaseNotes } from "../apps/desktop/src/shared/changelog.ts";

const file = new URL("../CHANGELOG.md", import.meta.url);
const [cmd, arg, flag] = process.argv.slice(2);
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
} else if (cmd === "announce" && version) {
  if (!release) fail(missing);
  const body = discordAnnouncement(release, `https://github.com/janoelze/cmd/releases/tag/v${version}`);
  if (flag === "--dry-run") console.log(JSON.stringify(body, null, 2));
  else {
    const webhook = process.env.CMD_RELEASES_WEBHOOK || fail("announce: set CMD_RELEASES_WEBHOOK to the #whats-new webhook");
    const res = await fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) fail(`announce: Discord answered ${res.status}: ${await res.text()}`);
    console.log(`Announced ${version} on Discord`);
  }
} else fail("usage: node scripts/changelog.mjs check [version] | notes <version> | announce <version> [--dry-run]");
