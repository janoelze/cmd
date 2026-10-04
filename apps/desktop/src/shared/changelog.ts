// CHANGELOG.md as data: the renderer's What's New sheet shows the releases since
// the version someone last saw, scripts/changelog.mjs checks a release has its
// section and prints it as the GitHub release notes, and a test lints the file.
// Format and style: .claude/skills/changelog/SKILL.md.

export const KINDS = ["New", "Improved", "Fixed", "Removed"] as const;
export type ChangeKind = (typeof KINDS)[number];

export interface Release {
  version: string;
  /** YYYY-MM-DD */
  date: string;
  /** Optional one-line headline under the version heading. */
  summary: string | null;
  sections: { kind: ChangeKind; entries: string[] }[];
}

const HEADING = /^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})$/;

/** Every release in the file, newest first. Lenient: lines it doesn't understand are skipped (lintChangelog reports them). */
export function parseChangelog(text: string): Release[] {
  const releases: Release[] = [];
  let release: Release | null = null;
  let section: Release["sections"][number] | null = null;
  for (const line of text.split("\n")) {
    const h = HEADING.exec(line);
    if (h) {
      release = { version: h[1]!, date: h[2]!, summary: null, sections: [] };
      releases.push(release);
      section = null;
    } else if (!release) continue;
    else if (line.startsWith("### ")) {
      const kind = line.slice(4).trim() as ChangeKind;
      section = KINDS.includes(kind) ? { kind, entries: [] } : null;
      if (section) release.sections.push(section);
    } else if (line.startsWith("- ") && section) section.entries.push(line.slice(2).trim());
    else if (line.trim() && !section && !line.startsWith("#") && release.summary === null) release.summary = line.trim();
  }
  return releases;
}

/** -1, 0 or 1; prerelease suffixes are ignored (the changelog has none). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0]!.split(".").map(Number);
  const pb = b.split("-")[0]!.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}

/** Releases newer than `after` up to and including `upTo`, newest first; all up to `upTo` when `after` is null. */
export function releasesBetween(releases: Release[], after: string | null, upTo: string): Release[] {
  return releases.filter((r) => compareVersions(r.version, upTo) <= 0 && (after === null || compareVersions(r.version, after) > 0));
}

/** One release as Markdown for the GitHub release page. */
export function releaseNotes(r: Release): string {
  const parts = r.summary ? [r.summary] : [];
  for (const s of r.sections) parts.push(`### ${s.kind}\n\n${s.entries.map((e) => `- ${e}`).join("\n")}`);
  return parts.join("\n\n") + "\n";
}

/**
 * Hard caps, so release notes stay short however many releases an agent writes:
 * characters and sentences per entry (New entries get room for a bold name and
 * a second sentence), entries per section and per release. A release with more
 * to say folds related changes together and leaves the small ones out.
 */
export const LIMITS = {
  newEntry: { chars: 200, sentences: 2 },
  entry: { chars: 140, sentences: 1 },
  summary: { chars: 100, sentences: 1 },
  name: 40,
  perSection: 5,
  perRelease: 10,
} as const;
const BANNED = [
  "supercharge",
  "unleash",
  "revolutionary",
  "seamless",
  "seamlessly",
  "blazing",
  "powerful",
  "ai-powered",
  "agentic",
  "autonomous",
  "next-generation",
  "10x",
  "vibe",
  "game-changer",
  "various",
  "minor improvements",
  "several improvements",
  "bug fixes and improvements",
];
const INTERNALS: [RegExp, string][] = [
  [/^[a-z][\w-]*(\([^)]*\))?: /, "starts like a commit message (\"fix: …\", \"website: …\")"],
  [/(^|[\s(])#\d+\b/, "has an issue or PR number"],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/, "has what looks like a commit hash"],
  [/\bOSC ?\d/i, "names an OSC sequence"],
  [/\bPTY host\b|\bpty\b/i, "names the PTY host"],
  [/\b[\w/-]+\.(ts|tsx|mjs|js|css)\b/, "names a source file"],
  [/\b(pane|core|settings|agents?|events?)\.[a-z]+[A-Z]?\w*\(/, "names an RPC method"],
];

/** Sentences in an entry, after its bold name: ". " or a final "." ends one. */
const sentences = (plain: string) => plain.replace(/^\*\*[^*]+\*\* /, "").match(/[.?](\s|$)/g)?.length ?? 0;

/** Lint one entry's (or the summary's) text; returns the problems. */
function lintEntry(e: string, kind: ChangeKind | "summary"): string[] {
  const problems: string[] = [];
  const plain = e.replace(/`[^`]*`/g, "code").replace(/\]\([^)]*\)/g, "]");
  const limit = kind === "New" ? LIMITS.newEntry : kind === "summary" ? LIMITS.summary : LIMITS.entry;
  const what = kind === "New" ? "New entries" : kind === "summary" ? "summaries" : `${kind} entries`;
  if (!/\.(\*\*)?$|\.\)$/.test(e)) problems.push("doesn't end with a period");
  if (e.length > limit.chars) problems.push(`is ${e.length} characters; ${what} have at most ${limit.chars}`);
  const n = sentences(plain);
  if (n > limit.sentences) problems.push(`has ${n} sentences; ${what} have at most ${limit.sentences}`);
  const name = /^\*\*([^*]+)\*\*/.exec(e)?.[1];
  if (name && name.length > LIMITS.name) problems.push(`has a ${name.length}-character name; at most ${LIMITS.name}`);
  if (plain.includes("!")) problems.push("has an exclamation mark");
  if (/^[a-z]/.test(e)) problems.push("starts with a lowercase letter");
  if (kind === "New" && !/^\*\*[^*]+\.\*\* \S/.test(e)) problems.push('New entries start with a bold name ending in a period ("**Name.** What you can do.")');
  const lower = plain.toLowerCase();
  for (const w of BANNED) if (new RegExp(`(^|[^\\w-])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`).test(lower)) problems.push(`uses "${w}"`);
  for (const [re, what] of INTERNALS) if (re.test(plain)) problems.push(what);
  return problems;
}

/**
 * The changelog's format and the mechanical half of its style rules (see the
 * changelog skill). Returns one message per problem, each with its line number.
 */
export function lintChangelog(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split("\n");
  const at = (i: number, msg: string) => problems.push(`CHANGELOG.md:${i + 1}: ${msg}`);
  if (lines[0] !== "# Changelog") at(0, 'the first line must be "# Changelog"');

  let version: string | null = null;
  let previous: string | null = null;
  let kinds: ChangeKind[] = [];
  let kind: ChangeKind | null = null;
  let entries = 0;
  let total = 0;
  let headingLine = 0;
  let hasSummary = false;
  const endRelease = () => {
    if (version && !hasSummary && kinds.length === 0) at(headingLine, `${version} has no summary and no entries`);
    if (kind && entries === 0) at(headingLine, `${version}: "### ${kind}" is empty`);
  };

  lines.forEach((line, i) => {
    if (line.startsWith("## ")) {
      endRelease();
      const h = HEADING.exec(line);
      if (!h) return at(i, `release headings look like "## 1.2.3 — 2026-10-05" (em dash), not "${line}"`);
      const [, v, date] = h as unknown as [string, string, string];
      if (Number.isNaN(Date.parse(date))) at(i, `${date} is not a date`);
      if (previous && compareVersions(v, previous) >= 0) at(i, `${v} comes after ${previous}; newest first, each version once`);
      version = previous = v;
      kinds = [];
      kind = null;
      entries = total = 0;
      headingLine = i;
      hasSummary = false;
      return;
    }
    if (!version) return;
    if (line.startsWith("### ")) {
      if (kind && entries === 0) at(i, `"### ${kind}" is empty`);
      const k = line.slice(4).trim() as ChangeKind;
      if (!KINDS.includes(k)) return at(i, `sections are ${KINDS.map((k) => `"### ${k}"`).join(", ")}, not "${line}"`);
      if (kinds.includes(k)) at(i, `"### ${k}" appears twice in ${version}`);
      else if (kinds.some((p) => KINDS.indexOf(p) > KINDS.indexOf(k))) at(i, `"### ${k}" is out of order; sections go ${KINDS.join(", ")}`);
      kinds.push(k);
      kind = k;
      entries = 0;
      return;
    }
    if (line.startsWith("#")) return at(i, `unexpected heading "${line}"`);
    if (line.startsWith("- ")) {
      if (!kind) return at(i, "an entry outside a section");
      entries++;
      total++;
      if (entries === LIMITS.perSection + 1) at(i, `"### ${kind}" in ${version} has more than ${LIMITS.perSection} entries; fold related ones, leave small ones out`);
      if (total === LIMITS.perRelease + 1) at(i, `${version} has more than ${LIMITS.perRelease} entries; fold related ones, leave small ones out`);
      for (const p of lintEntry(line.slice(2).trim(), kind)) at(i, `entry ${p}`);
      return;
    }
    if (!line.trim()) return;
    if (/^\s/.test(line)) return at(i, "entries stay on one line");
    if (kind || kinds.length) return at(i, "text inside a section that isn't a \"- \" entry");
    if (hasSummary) return at(i, "the summary is one line");
    hasSummary = true;
    for (const p of lintEntry(line.trim(), "summary")) at(i, `summary ${p}`);
  });
  endRelease();
  return problems;
}
