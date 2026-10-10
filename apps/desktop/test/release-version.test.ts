// A tag build's version has one source, apps/desktop/package.json: scripts/release-version.mjs
// gates release tags on it and writes prerelease tags into it, and electron.vite.config.ts
// derives What's New's version and the usage stats key from it alone.
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error: a plain .mjs script, no types
import { releaseVersion } from "../../../scripts/release-version.mjs";

const root = path.join(import.meta.dirname, "../../..");
const script = path.join(root, "scripts/release-version.mjs");
const pkgPath = path.join(root, "apps/desktop/package.json");

// The config reads package.json through node:fs; this hands it a prerelease's version.
const fake = vi.hoisted(() => ({ version: "" }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const text = (real.readFileSync as (...a: unknown[]) => string | Buffer)(file, ...rest);
    if (fake.version && typeof file === "string" && file === pkgPath) return String(text).replace(/("version"\s*:\s*)"[^"]*"/, `$1"${fake.version}"`);
    return text;
  }) as typeof real.readFileSync;
  return { ...real, default: { ...real, readFileSync }, readFileSync };
});

describe("releaseVersion", () => {
  it("passes a release tag that equals package.json's version", () => {
    expect(releaseVersion("v1.2.3", "1.2.3")).toEqual({ version: "1.2.3", prerelease: false, write: false });
    expect(releaseVersion("refs/tags/v1.2.3", "1.2.3").version).toBe("1.2.3");
  });

  it("fails a release tag that differs from package.json's version", () => {
    expect(() => releaseVersion("v1.2.4", "1.2.3")).toThrow(/doesn't match apps\/desktop\/package.json \(1.2.3\)/);
  });

  it("takes a prerelease tag's version, to be written into package.json", () => {
    expect(releaseVersion("v1.2.3-beta.1", "1.2.2")).toEqual({ version: "1.2.3-beta.1", prerelease: true, write: true });
    expect(releaseVersion("v1.2.3-beta.1", "1.2.3-beta.1").write).toBe(false);
  });

  it("refuses what isn't a version tag", () => {
    expect(() => releaseVersion("vnext", "1.2.3")).toThrow(/isn't a release tag/);
    expect(() => releaseVersion("v1.2", "1.2")).toThrow(/isn't a release tag/);
  });
});

describe("scripts/release-version.mjs", () => {
  const copy = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-release-version-"));
    const file = path.join(dir, "package.json");
    fs.writeFileSync(file, JSON.stringify({ name: "@cmd/desktop", version: "1.2.2", dependencies: { x: "1.0.0" } }, null, 2) + "\n");
    return file;
  };
  const run = (tag: string, file: string) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [script, tag, file], { encoding: "utf8", stdio: "pipe" }) };
    } catch (err) {
      const e = err as { status: number; stderr: string };
      return { code: e.status, out: e.stderr };
    }
  };

  it("writes a prerelease tag's version into package.json and keeps the rest", () => {
    const file = copy();
    const before = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(run("v1.2.3-beta.1", file)).toMatchObject({ code: 0 });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ...before, version: "1.2.3-beta.1" });
  });

  it("exits 1 on a release tag that doesn't match, and leaves package.json alone", () => {
    const file = copy();
    const before = fs.readFileSync(file, "utf8");
    const { code, out } = run("v1.2.3", file);
    expect(code).toBe(1);
    expect(out).toContain("doesn't match");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("passes a matching release tag", () => {
    expect(run("v1.2.2", copy())).toEqual({ code: 0, out: "1.2.2\n" });
  });
});

describe("electron.vite.config.ts", () => {
  // app.getVersion() in the packaged app is package.json's version (CI's extraMetadata.version
  // is the tag, which the step above made equal to it). What's New and the usage key must follow.
  it("takes What's New's version and the usage key from package.json's version", async () => {
    fake.version = "1.2.3-beta.1";
    vi.stubEnv("CMD_USAGE_SECRET", "s3cret");
    try {
      const { default: config } = await import("../electron.vite.config.ts");
      const c = config as { main: { define: Record<string, string> }; renderer: { define: Record<string, string> } };
      expect(c.renderer.define.__APP_VERSION__).toBe(JSON.stringify("1.2.3-beta.1"));
      expect(c.main.define.__USAGE_KEY__).toBe(JSON.stringify(createHmac("sha256", "s3cret").update("cmd-usage:1.2.3-beta.1").digest("hex")));
    } finally {
      fake.version = "";
      vi.unstubAllEnvs();
    }
  });

  it("reads the version in one place", () => {
    const src = fs.readFileSync(path.join(root, "apps/desktop/electron.vite.config.ts"), "utf8");
    expect(src.match(/"package\.json"/g)).toHaveLength(1);
    expect(src.match(/\.version\b/g)).toHaveLength(1);
  });
});
