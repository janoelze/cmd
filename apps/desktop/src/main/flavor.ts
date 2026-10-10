// Which instance this build is (release or dev, protocol/instance.ts), as a pure
// function over facts fixed at build time, so it is unit-tested without Electron.
// Not from the app's name: app.getName() reads productName from the packaged
// package.json, which said "cmd" in a `pnpm dist` build too, so that build ran as
// the release instance on the installed app's state and migrated its event log.
// `pnpm dist` (electron-builder.dev.yml) writes "cmdFlavor": "dev" into the
// packaged package.json (extraMetadata); the CI config writes nothing. The field
// is inside app.asar, so renaming or moving the .app doesn't change it.

import fs from "node:fs";
import path from "node:path";
import type { InstanceName } from "@cmd/protocol/node";

/** The package.json field electron-builder.dev.yml sets for development builds. */
export const FLAVOR_FIELD = "cmdFlavor";

/** The instance a build runs as: dev when run from source (pnpm dev) or packaged as a dev build, else release. */
export function buildInstance(o: { isPackaged: boolean; flavor: unknown }): InstanceName {
  return !o.isPackaged || o.flavor === "dev" ? "dev" : "release";
}

/** The flavor baked into the app's package.json (app.getAppPath()), undefined when it has none. */
export function readFlavor(appPath: string): unknown {
  try {
    return (JSON.parse(fs.readFileSync(path.join(appPath, "package.json"), "utf8")) as Record<string, unknown>)[FLAVOR_FIELD];
  } catch {
    return undefined;
  }
}
