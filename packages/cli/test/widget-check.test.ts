// `cmd widget check <dir>` on widget packages (docs/56): the good fixture passes with 0,
// each bad-* fixture fails with 2 and names the field that's wrong; a Frame's src naming no
// page of the package is a warning; the CLI sandboxes the
// toolchain by the core's own rule.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sandboxAvailable, sandboxMode } from "@cmd/core/magic";
import { checkPackage, widgetCommand } from "../src/widget.ts";
import { NO_SANDBOX, toolSandbox } from "../src/widget-new.ts";

// Inside another sandbox (an agent's) the toolchain runs only when told to go on without one.
if (!sandboxAvailable()) process.env.CMD_MAGIC_UNSANDBOXED = "1";

const fixtures = path.join(import.meta.dirname, "fixtures", "widgets");

/** Each bad fixture, and the field its message starts with. */
const BAD: Record<string, string> = {
  "bad-no-api": "cmd.api",
  "bad-api-major": "cmd.api",
  "bad-engines": "engines.cmd",
  "bad-version": "version",
  "bad-main-outside": "cmd.widgets[0].main",
  "bad-main-link": "cmd.widgets[0].main",
  "bad-run-shell": "cmd.permissions.run",
  "bad-read-home": "cmd.permissions.read",
  "bad-duplicate-id": "cmd.widgets[1].id",
  "bad-secret-host": "cmd.widgets[0].config[1].host",
};

async function check(dir: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(String(s)));
  const error = vi.spyOn(console, "error").mockImplementation((s: string) => void err.push(String(s)));
  try {
    const code = await widgetCommand(["check", path.join(fixtures, dir)]);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe("cmd widget check on packages", () => {
  it("passes the good package with 0", async () => {
    const r = await check("good");
    expect(r.code).toBe(0);
    expect(r.out).toContain("good 1.0.0");
    expect(r.out).toContain("pkg:good/main");
  });

  for (const [dir, field] of Object.entries(BAD))
    it(`refuses ${dir} with 2, naming ${field}`, async () => {
      const r = await check(dir);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`  ${field}: `);
    });

  it("warns, without failing, about a Frame's src that names no page of the package", async () => {
    const err: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await checkPackage(path.join(fixtures, "frame-pages"), false, "0.30.0", async () => null, { types: false })).toBe(0);
    } finally {
      write.mockRestore();
      log.mockRestore();
    }
    const warnings = err.filter((l) => l.includes("isn't in this package"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("src/main.tsx:8: meter.html isn't in this package");
  });

  it("asks the running cmd for its version when it has none of its own, and says when nobody answers", async () => {
    const err: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await checkPackage(path.join(fixtures, "bad-engines"), false, null, async () => "0.30.0")).toBe(2);
      expect(err.join("")).not.toContain("not checked");
      expect(await checkPackage(path.join(fixtures, "bad-engines"), false, null, async () => null)).toBe(0);
      expect(err.join("")).toContain("engines.cmd not checked: no cmd running");
    } finally {
      write.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });

  it("exits with those codes as a process", () => {
    const main = path.join(import.meta.dirname, "..", "src", "main.ts");
    const run = (dir: string) => {
      try {
        execFileSync(process.execPath, ["--no-warnings", main, "widget", "check", path.join(fixtures, dir)], { stdio: "pipe" });
        return { status: 0, stderr: "" };
      } catch (e) {
        const x = e as { status: number; stderr: Buffer };
        return { status: x.status, stderr: x.stderr.toString() };
      }
    };
    expect(run("good").status).toBe(0);
    const bad = run("bad-run-shell");
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("cmd.permissions.run");
  });
});

describe("the sandbox cmd widget check and preview run in", () => {
  const was = process.env.CMD_MAGIC_UNSANDBOXED;
  afterEach(() => (was === undefined ? delete process.env.CMD_MAGIC_UNSANDBOXED : (process.env.CMD_MAGIC_UNSANDBOXED = was)));

  it("is the core's rule: sandboxed, unless it can't be and CMD_MAGIC_UNSANDBOXED=1 says to go on", () => {
    for (const env of [undefined, "1", "0"]) {
      if (env === undefined) delete process.env.CMD_MAGIC_UNSANDBOXED;
      else process.env.CMD_MAGIC_UNSANDBOXED = env;
      expect(sandboxMode()).toBe(env === "1" && !sandboxAvailable() ? "off" : "required");
      expect(toolSandbox()).toBe(sandboxMode() === "off" || sandboxAvailable() ? sandboxMode() : null);
    }
  });

  it.skipIf(sandboxAvailable())("refuses to type-check unsandboxed unless told, and says how", async () => {
    delete process.env.CMD_MAGIC_UNSANDBOXED;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await checkPackage(path.join(fixtures, "good"), false, "0.30.0")).toBe(2);
      expect(err.mock.calls.flat().join("\n")).toContain(NO_SANDBOX);
    } finally {
      err.mockRestore();
    }
  });

  it("is decided in one place: no other source in the core or the CLI reads CMD_MAGIC_UNSANDBOXED's rule", () => {
    const root = path.join(import.meta.dirname, "../..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && /CMD_MAGIC_UNSANDBOXED\s*===|sandboxAvailable\(\)\s*\?\s*"required"/.test(fs.readFileSync(p, "utf8"))) hits.push(path.relative(root, p));
      }
    };
    for (const pkg of ["core/src", "cli/src"]) walk(path.join(root, pkg));
    expect(hits).toEqual(["core/src/lib/sandbox.ts"]);
  });
});
