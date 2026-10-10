// Which instance this build is (release or dev, protocol/instance.ts), as a pure
// function over facts fixed at build time, so it is unit-tested without Electron.
// Not from the app's name: app.getName() reads productName from the packaged
// package.json, which said "cmd" in a `pnpm dist` build too, so that build ran as
// the release instance on the installed app's state and migrated its event log.
// `pnpm dist` (electron-builder.dev.yml) bakes in two markers, and either is
// enough: "cmdFlavor": "dev" in the packaged package.json (extraMetadata, inside
// app.asar, so renaming or moving the .app doesn't change it), and the file
// Resources/runtime/instance (protocol/instance.ts, hasDevMarker), which the core
// reads too, so it refuses the installed app's data even if this got it wrong.
// The CI config (electron-builder.yml) writes neither.

import fs from "node:fs";
import path from "node:path";
import type { InstanceName } from "@cmd/protocol/node";

/** The package.json field electron-builder.dev.yml sets for development builds. */
export const FLAVOR_FIELD = "cmdFlavor";

/**
 * The instance a build runs as: dev when run from source (pnpm dev) or packaged
 * as a dev build (`flavor` from readFlavor, `marker` from hasDevMarker), else release.
 */
export function buildInstance(o: { isPackaged: boolean; flavor: unknown; marker?: boolean }): InstanceName {
  return !o.isPackaged || o.flavor === "dev" || o.marker === true ? "dev" : "release";
}

/** The flavor baked into the app's package.json (app.getAppPath()), undefined when it has none. */
export function readFlavor(appPath: string): unknown {
  try {
    return (JSON.parse(fs.readFileSync(path.join(appPath, "package.json"), "utf8")) as Record<string, unknown>)[FLAVOR_FIELD];
  } catch {
    return undefined;
  }
}
