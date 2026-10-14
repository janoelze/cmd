// `cmd widget link|unlink|remove` (docs/56) with a throwaway CMD_WIDGETS_HOME: link checks the
// package, links it under its name (and refuses a name another package holds), and with a core
// running waits for the Library to list it, asks for its permissions and prints its entry;
// unlink takes a link out and leaves a real folder alone unless --force.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WidgetEntry } from "@cmd/protocol";
import { Core, type PtyFactory } from "@cmd/core";
import { widgetCommand } from "../src/widget.ts";

const fixtures = path.join(import.meta.dirname, "fixtures", "widgets");
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-link-")));
let home: string;
const env = { home: process.env.CMD_WIDGETS_HOME, socket: process.env.CMD_SOCKET };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(scratch, "home-"));
  process.env.CMD_WIDGETS_HOME = home;
  process.env.CMD_SOCKET = path.join(scratch, "none.sock"); // no core, unless a test starts one
});
afterEach(() => {
  process.env.CMD_WIDGETS_HOME = env.home;
  process.env.CMD_SOCKET = env.socket;
  if (env.home === undefined) delete process.env.CMD_WIDGETS_HOME;
  if (env.socket === undefined) delete process.env.CMD_SOCKET;
});
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((s: string) => void out.push(String(s)));
  const error = vi.spyOn(console, "error").mockImplementation((s: string) => void err.push(String(s)));
  const write = vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => (err.push(String(s)), true));
  try {
    const code = await widgetCommand(argv);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
    write.mockRestore();
  }
}

/** A copy of the good fixture (it asks for a host, a program…), named `name`. */
function pkg(name = "good"): string {
  const dir = path.join(fs.mkdtempSync(path.join(scratch, "src-")), name);
  fs.cpSync(path.join(fixtures, "good"), dir, { recursive: true });
  const json = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  json.name = name;
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(json, null, 2));
  return dir;
}

describe("cmd widget link without a core", () => {
  it("links a package under its name, and again is fine", async () => {
    const dir = pkg();
    const r = await cli("link", dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("good 1.0.0 linked");
    expect(fs.readlinkSync(path.join(home, "good"))).toBe(dir);
    expect((await cli("link", dir)).code).toBe(0);
  });

  it("refuses a package with problems, naming the field, and links nothing", async () => {
    const r = await cli("link", path.join(fixtures, "bad-no-api"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("cmd.api");
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("refuses when another package sits under the name", async () => {
    await cli("link", pkg());
    const r = await cli("link", pkg());
    expect(r.code).toBe(1);
    expect(r.err).toContain("Unlink it first");
    fs.mkdirSync(path.join(home, "other"));
    const o = await cli("link", pkg("other"));
    expect(o.code).toBe(1);
    expect(o.err).toContain("a package of its own");
  });

  it("unlinks a link, and leaves a real folder alone unless --force", async () => {
    const dir = pkg();
    await cli("link", dir);
    const u = await cli("unlink", "good");
    expect(u.code).toBe(0);
    expect(fs.existsSync(path.join(home, "good"))).toBe(false);
    expect(fs.existsSync(dir)).toBe(true); // the folder itself stays
    fs.cpSync(dir, path.join(home, "good"), { recursive: true });
    const refused = await cli("remove", "good");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("Remove it in Finder");
    expect(fs.existsSync(path.join(home, "good"))).toBe(true);
    expect((await cli("remove", "good", "--force")).code).toBe(0);
    expect(fs.existsSync(path.join(home, "good"))).toBe(false);
    expect((await cli("unlink", "../etc")).code).toBe(1);
  });
});

/** This core opens no terminals. */
const noTerminals: PtyFactory = () => {
  throw new Error("no terminals here");
};

describe("cmd widget link with a core", () => {
  it("waits for the Library to list it, asks for its permissions, prints the entry; unlink takes it out", async () => {
    const socketPath = path.join(scratch, "core.sock");
    const core = new Core({ socketPath, dbPath: null, settingsPath: null, terminals: noTerminals, pollMs: 0, stateDir: fs.mkdtempSync(path.join(scratch, "state-")) });
    try {
      await core.listen();
      core.start();
      await core.scheduler.idle();
      process.env.CMD_SOCKET = socketPath;
      const dir = pkg();
      const t0 = Date.now();
      const r = await cli("link", dir);
      expect(r.code).toBe(0);
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(r.out).toContain("pkg:good/main");
      expect(r.out).toContain("good 1.0.0 · API 1");
      const entry = (core.handlers["widget.list"]({}) as WidgetEntry[]).find((e) => e.name === "good");
      expect(entry?.link).toBe(dir);
      expect(entry?.ask).toEqual({ granted: null });
      const u = await cli("unlink", "good");
      expect(u.code).toBe(0);
      expect(u.err).not.toContain("still lists");
      expect((core.handlers["widget.list"]({}) as WidgetEntry[]).some((e) => e.name === "good")).toBe(false);
    } finally {
      await core.close();
    }
  });
});
