// A build's instance is fixed when it is packaged: `pnpm dist` (electron-builder.dev.yml)
// bakes cmdFlavor "dev" into app.asar's package.json, the release config (CI) doesn't.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEV_MARKER } from "@cmd/protocol/node";
import { buildInstance, FLAVOR_FIELD, readFlavor } from "../src/main/flavor.ts";

const desktop = path.join(import.meta.dirname, "..");
const yml = (name: string) => fs.readFileSync(path.join(desktop, name), "utf8");

describe("buildInstance", () => {
  it("runs from source as dev", () => {
    expect(buildInstance({ isPackaged: false, flavor: undefined })).toBe("dev");
    expect(buildInstance({ isPackaged: false, flavor: "release" })).toBe("dev");
  });

  it("runs a packaged dev build as dev, whatever its name", () => {
    expect(buildInstance({ isPackaged: true, flavor: "dev" })).toBe("dev");
  });

  it("takes either marker: the package.json field or the runtime's instance file", () => {
    expect(buildInstance({ isPackaged: true, flavor: undefined, marker: true })).toBe("dev");
    expect(buildInstance({ isPackaged: true, flavor: "dev", marker: false })).toBe("dev");
    expect(buildInstance({ isPackaged: true, flavor: undefined, marker: false })).toBe("release");
  });

  it("runs any other packaged build as release", () => {
    expect(buildInstance({ isPackaged: true, flavor: undefined })).toBe("release");
    expect(buildInstance({ isPackaged: true, flavor: "Dev" })).toBe("release");
    expect(buildInstance({ isPackaged: true, flavor: true })).toBe("release");
  });
});

describe("readFlavor", () => {
  it("reads the field from the app's package.json, undefined without one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-flavor-"));
    try {
      expect(readFlavor(dir)).toBeUndefined();
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ productName: "cmd" }));
      expect(readFlavor(dir)).toBeUndefined();
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ productName: "cmd", [FLAVOR_FIELD]: "dev" }));
      expect(readFlavor(dir)).toBe("dev");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds no flavor in the source package.json (what release builds package)", () => {
    expect(readFlavor(desktop)).toBeUndefined();
  });
});

describe("electron-builder configs", () => {
  it("bake the dev flavor into pnpm dist builds", () => {
    expect(yml("electron-builder.dev.yml")).toMatch(new RegExp(`^extraMetadata:\\n(?:  .*\\n)*  ${FLAVOR_FIELD}: dev$`, "m"));
  });

  it("put the dev marker next to the core in pnpm dist builds", () => {
    expect(yml("electron-builder.dev.yml")).toMatch(new RegExp(`^extraResources:\\n  - from: build/dev/instance\\n    to: runtime/${DEV_MARKER}$`, "m"));
    expect(fs.readFileSync(path.join(desktop, "build/dev/instance"), "utf8").trim()).toBe("dev");
  });

  it("leave release builds without either", () => {
    const release = yml("electron-builder.yml");
    expect(release).not.toContain(FLAVOR_FIELD);
    expect(release).not.toContain("extraMetadata");
    expect(release).not.toContain("build/dev");
    // CI packages with electron-builder.yml and only overrides the version (.github/workflows/build.yml).
    const ci = fs.readFileSync(path.join(desktop, "../../.github/workflows/build.yml"), "utf8");
    expect(ci).not.toContain("electron-builder.dev.yml");
    expect(ci).not.toContain(FLAVOR_FIELD);
    expect([...ci.matchAll(/-c\.(\S+?)=/g)].map((m) => m[1]).filter((k) => k!.startsWith("extra"))).toEqual(["extraMetadata.version", "extraMetadata.version"]);
  });
});
