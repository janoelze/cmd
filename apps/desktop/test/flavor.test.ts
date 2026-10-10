// A build's instance is fixed when it is packaged: `pnpm dist` (electron-builder.dev.yml)
// bakes cmdFlavor "dev" into app.asar's package.json, the release config (CI) doesn't.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

  it("leave release builds without one", () => {
    expect(yml("electron-builder.yml")).not.toContain(FLAVOR_FIELD);
  });
});
