import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compareVersions, lintChangelog, parseChangelog, releaseNotes, releasesBetween } from "../src/shared/changelog.ts";
import type { claimWhatsNew } from "../src/main/whats-new.ts";

const root = path.join(import.meta.dirname, "../../..");
const CHANGELOG = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const VERSION = JSON.parse(fs.readFileSync(path.join(root, "apps/desktop/package.json"), "utf8")).version as string;

const SAMPLE = `# Changelog

Intro.

## 0.10.0 — 2026-10-06

A calmer release.

### New

- **What's New.** See what changed after an update, from the status bar's sparkles.

### Fixed

- Terminals keep their last line when the window is resized.

## 0.9.1 — 2026-10-05

Fixes to how cmd updates itself.

## 0.9.0 — 2026-10-04

### Improved

- The palette finds windows by folder. See [the docs](https://example.com/docs).
`;

describe("CHANGELOG.md", () => {
  it("passes the lint", () => {
    expect(lintChangelog(CHANGELOG)).toEqual([]);
  });

  it("has a section for the app's version", () => {
    expect(parseChangelog(CHANGELOG).map((r) => r.version)).toContain(VERSION.split("-")[0]);
  });
});

describe("parseChangelog", () => {
  it("reads releases, summaries and sections", () => {
    const [a, b, c] = parseChangelog(SAMPLE);
    expect(a).toEqual({
      version: "0.10.0",
      date: "2026-10-06",
      summary: "A calmer release.",
      sections: [
        { kind: "New", entries: ["**What's New.** See what changed after an update, from the status bar's sparkles."] },
        { kind: "Fixed", entries: ["Terminals keep their last line when the window is resized."] },
      ],
    });
    expect(b).toMatchObject({ version: "0.9.1", summary: "Fixes to how cmd updates itself.", sections: [] });
    expect(c!.sections[0]!.kind).toBe("Improved");
  });

  it("prints a release's notes", () => {
    expect(releaseNotes(parseChangelog(SAMPLE)[0]!)).toBe(
      "A calmer release.\n\n### New\n\n- **What's New.** See what changed after an update, from the status bar's sparkles.\n\n### Fixed\n\n- Terminals keep their last line when the window is resized.\n",
    );
  });
});

describe("releasesBetween", () => {
  const all = parseChangelog(SAMPLE);
  const versions = (after: string | null, upTo: string) => releasesBetween(all, after, upTo).map((r) => r.version);
  it("takes the releases after the last one seen", () => {
    expect(versions("0.9.0", "0.10.0")).toEqual(["0.10.0", "0.9.1"]);
    expect(versions("0.9.1", "0.10.0")).toEqual(["0.10.0"]);
    expect(versions("0.10.0", "0.10.0")).toEqual([]);
    expect(versions(null, "0.9.1")).toEqual(["0.9.1", "0.9.0"]);
  });
  it("compares versions numerically", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(0);
  });
});

describe("lintChangelog", () => {
  const lint = (body: string) => lintChangelog(`# Changelog\n\n## 1.0.0 — 2026-10-05\n\n${body}\n`);
  it("accepts the sample", () => {
    expect(lintChangelog(SAMPLE)).toEqual([]);
  });
  it("wants the heading format, newest first and each version once", () => {
    expect(lintChangelog("# Changelog\n\n## 1.0.0 - 2026-10-05\n\nOk.\n")[0]).toMatch(/em dash/);
    expect(lintChangelog("# Changelog\n\n## 0.9.0 — 2026-10-04\n\nOk.\n\n## 1.0.0 — 2026-10-05\n\nOk.\n")[0]).toMatch(/newest first/);
    expect(lintChangelog("# Changelog\n\n## 1.0.0 — 2026-10-05\n\nOk.\n\n## 1.0.0 — 2026-10-05\n\nOk.\n")[0]).toMatch(/newest first/);
  });
  it("wants known sections in order, not empty, and something in every release", () => {
    expect(lint("### Changed\n\n- Something.")[0]).toMatch(/sections are/);
    expect(lint("### Fixed\n\n- A.\n\n### New\n\n- **B.** C.")[0]).toMatch(/out of order/);
    expect(lint("### Fixed\n\n### Removed\n\n- A.")[0]).toMatch(/empty/);
    expect(lint("")[0]).toMatch(/no summary and no entries/);
  });
  it("checks entries", () => {
    const one = (entry: string, kind = "Fixed") => lint(`### ${kind}\n\n- ${entry}`);
    expect(one("Works now")).toEqual([expect.stringMatching(/period/)]);
    expect(one("It works now!")).toContainEqual(expect.stringMatching(/exclamation/));
    expect(one("fix: the thing.")).toEqual(expect.arrayContaining([expect.stringMatching(/commit message/)]));
    expect(one("Fixed the crash from #123.")).toEqual([expect.stringMatching(/issue or PR/)]);
    expect(one("Reverted 1a2b3c4d.")).toEqual([expect.stringMatching(/hash/)]);
    expect(one("Paste works in panes.ts.")).toEqual([expect.stringMatching(/source file/)]);
    expect(one("A seamless restore.")).toEqual([expect.stringMatching(/"seamless"/)]);
    expect(one("Various fixes.")).toEqual([expect.stringMatching(/"various"/)]);
    expect(one(`${"Long. ".repeat(50)}`.trim())).toEqual([expect.stringMatching(/characters/)]);
    expect(one("Search finds sessions.", "New")).toEqual([expect.stringMatching(/bold name/)]);
    expect(one("**Search.** Finds sessions.", "New")).toEqual([]);
    expect(one("Set `updates.mode` to `off` to stop it.")).toEqual([]);
  });
  it("keeps entries on one line and the summary to one line", () => {
    expect(lint("### Fixed\n\n- A long\n  entry.")).toContainEqual(expect.stringMatching(/stay on one line/));
    expect(lint("First line.\nSecond line.")[0]).toMatch(/summary is one line/);
  });
});

describe("claimWhatsNew", () => {
  // claimWhatsNew answers once per process; each case loads a fresh copy.
  const fresh = async (): Promise<typeof claimWhatsNew> => (vi.resetModules(), (await import("../src/main/whats-new.ts")).claimWhatsNew);
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "whats-new-"));
  const write = (d: string, seen: string) => fs.writeFileSync(path.join(d, "whats-new.json"), JSON.stringify({ seen }));

  it("shows nothing on a new install, and records the version", async () => {
    const d = dir();
    expect((await fresh())(d, "1.0.0", false, false)).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(d, "whats-new.json"), "utf8"))).toEqual({ seen: "1.0.0" });
  });
  it("shows the current release to someone updating from before What's New", async () => {
    expect((await fresh())(dir(), "1.0.0", true, false)).toEqual({ after: null });
  });
  it("shows what changed since the last version, once", async () => {
    const d = dir();
    write(d, "0.9.0");
    const claim = await fresh();
    expect(claim(d, "1.0.0", true, false)).toEqual({ after: "0.9.0" });
    expect(claim(d, "1.0.0", true, false)).toBeNull();
    expect((await fresh())(d, "1.0.0", true, false)).toBeNull();
  });
  it("never opens in development builds", async () => {
    const d = dir();
    write(d, "0.9.0");
    expect((await fresh())(d, "1.0.0", true, true)).toBeNull();
  });
});
