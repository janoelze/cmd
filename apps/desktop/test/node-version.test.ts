// One Node major for dev, tests, CI and the release: Electron's, which runs the packaged core.
// .node-version names it (CI's setup-node reads it), package.json's engines and @types/node
// follow it, and this fails when an Electron upgrade moves its bundled Node to another major.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../../..");
const major = (v: string) => Number(/(\d+)/.exec(v)?.[1]);
const pinned = Number(fs.readFileSync(path.join(root, ".node-version"), "utf8").trim());
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { engines: { node: string }; devDependencies: Record<string, string> };

/** The installed Electron binary, from the electron package's path.txt; null when it isn't installed. */
function electronBinary(): string | null {
  const dir = path.join(root, "apps/desktop/node_modules/electron");
  try {
    const bin = path.join(dir, "dist", fs.readFileSync(path.join(dir, "path.txt"), "utf8").trim());
    return fs.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

describe(".node-version", () => {
  it("is a bare major", () => {
    expect(Number.isInteger(pinned) && pinned > 0).toBe(true);
  });

  it("matches the Node that Electron bundles", (ctx) => {
    const bin = electronBinary();
    if (!bin) {
      console.log("node-version.test: Electron isn't installed (apps/desktop/node_modules/electron), so its Node can't be checked");
      return ctx.skip("Electron isn't installed");
    }
    const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env;
    const version = execFileSync(bin, ["-p", "process.versions.node"], { encoding: "utf8", env: { ...env, ELECTRON_RUN_AS_NODE: "1" } }).trim();
    expect(major(version), `Electron's Node is ${version}: set .node-version, engines.node and @types/node to its major`).toBe(pinned);
  });

  it("is the major of package.json's engines.node and @types/node", () => {
    expect(major(pkg.engines.node)).toBe(pinned);
    expect(major(pkg.devDependencies["@types/node"]!)).toBe(pinned);
  });
});
