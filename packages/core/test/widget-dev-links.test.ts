// What `cmd widget new|dev|test` link into a person's package (linkDevModules, docs/56 phase 3),
// and how much of a widget's console reaches clients (LogLimit): a link into a checkout that's
// gone is linked again to the one there is, a real install and a live link are left alone;
// the bucket lets a burst through, then the rate, and says how many it dropped.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkDevModules } from "../src/magic/package/toolchain.ts";
import { LogLimit } from "../src/widgets/host/log-limit.ts";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

/** A stand-in checkout with what linkDevModules lends. */
function repo(): string {
  const r = tmp("cmd-repo-");
  for (const d of ["packages/widget-api/node_modules/react", "packages/widget-api/node_modules/vitest", "packages/widget-api/node_modules/@types/react", "node_modules/@types/node", "node_modules/typescript/bin"]) fs.mkdirSync(path.join(r, d), { recursive: true });
  fs.writeFileSync(path.join(r, "packages/widget-api/node_modules/vitest/vitest.mjs"), "");
  fs.writeFileSync(path.join(r, "node_modules/typescript/bin/tsc"), "");
  return r;
}

describe("linkDevModules", () => {
  it("links again what pointed into a checkout that's gone, and leaves real installs and live links alone", () => {
    const pkg = tmp("cmd-pkg-");
    const first = repo();
    expect(linkDevModules(pkg, first)).toEqual(["@cmd/widget-api", "react", "vitest", "@types/react", "@types/node", "typescript"]);
    expect(fs.realpathSync(path.join(pkg, "node_modules/react"))).toBe(path.join(first, "packages/widget-api/node_modules/react"));

    // The person installed React themselves; the first checkout goes (a removed worktree).
    fs.rmSync(path.join(pkg, "node_modules/react"));
    fs.mkdirSync(path.join(pkg, "node_modules/react"));
    fs.rmSync(first, { recursive: true, force: true });
    const second = repo();
    expect(linkDevModules(pkg, second)).toEqual(["@cmd/widget-api", "vitest", "@types/react", "@types/node", "typescript"]);
    expect(fs.lstatSync(path.join(pkg, "node_modules/react")).isSymbolicLink()).toBe(false);
    expect(fs.realpathSync(path.join(pkg, "node_modules/@cmd/widget-api"))).toBe(path.join(second, "packages/widget-api"));
    expect(fs.realpathSync(path.join(pkg, "node_modules/.bin/vitest"))).toBe(path.join(second, "packages/widget-api/node_modules/vitest/vitest.mjs"));
    expect(fs.realpathSync(path.join(pkg, "node_modules/.bin/tsc"))).toBe(path.join(second, "node_modules/typescript/bin/tsc"));

    // Live links stay where they point, even with another checkout at hand.
    expect(linkDevModules(pkg, repo())).toEqual([]);
    expect(fs.realpathSync(path.join(pkg, "node_modules/vitest"))).toBe(path.join(second, "packages/widget-api/node_modules/vitest"));
  });

  it("relinks a dangling .bin link too", () => {
    const pkg = tmp("cmd-pkg-");
    linkDevModules(pkg, repo());
    fs.rmSync(path.join(pkg, "node_modules/.bin/tsc"));
    fs.symlinkSync("../nowhere/tsc", path.join(pkg, "node_modules/.bin/tsc"));
    linkDevModules(pkg, repo());
    expect(fs.readlinkSync(path.join(pkg, "node_modules/.bin/tsc"))).toBe(path.join("..", "typescript/bin/tsc"));
  });
});

describe("LogLimit", () => {
  it("lets a burst through, then the rate, and once a second says how many it dropped", () => {
    vi.useFakeTimers();
    let now = 0;
    const out: string[] = [];
    const limit = new LogLimit((l) => out.push(l.message), { rate: 50, burst: 100, reportMs: 1000 }, () => now);
    for (let i = 0; i < 1000; i++) limit.push({ level: "info", message: `a ${i}` });
    expect(out).toHaveLength(100);
    vi.advanceTimersByTime(1000);
    expect(out.at(-1)).toBe("… 900 lines dropped (it logs more than 50 a second)");
    now = 1000; // a second later: 50 more fit
    for (let i = 0; i < 60; i++) limit.push({ level: "info", message: `b ${i}` });
    expect(out.filter((m) => m.startsWith("b "))).toHaveLength(50);
    limit.close();
    expect(out.at(-1)).toBe("… 10 lines dropped (it logs more than 50 a second)");
    vi.advanceTimersByTime(5000);
    expect(out.filter((m) => m.includes("dropped"))).toHaveLength(2);
  });
});
