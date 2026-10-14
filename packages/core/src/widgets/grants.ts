// What a person granted a widget package (docs/56, "Capabilities and grants"): kept per
// instance in <state dir>/widget-packages/<name>/grants.json, never in the package, and
// out of reach of Magic's tools (their files are a widget folder's own). The core
// enforces declared ∩ granted; a package that declares more than its grant waits for one.

import fs from "node:fs";
import path from "node:path";
import { PERMISSION_KEYS, noPermissions, type WidgetPermissions } from "@cmd/protocol";
import { widgetPackageData } from "@cmd/protocol/node";

export interface Grants {
  /** The package version they were granted for. */
  version: string;
  permissions: WidgetPermissions;
}

export const grantsPath = (stateDir: string, name: string): string => path.join(widgetPackageData(stateDir, name), "grants.json");

/** The grants of a package, or null when there are none (never granted, or a file that isn't one). */
export function readGrants(stateDir: string, name: string): Grants | null {
  try {
    const g = JSON.parse(fs.readFileSync(grantsPath(stateDir, name), "utf8")) as Partial<Grants>;
    if (typeof g.version !== "string" || !g.permissions || typeof g.permissions !== "object") return null;
    const permissions = noPermissions();
    for (const k of PERMISSION_KEYS) {
      const v = (g.permissions as unknown as Record<string, unknown>)[k];
      permissions[k] = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    }
    return { version: g.version, permissions };
  } catch {
    return null;
  }
}

/** Keep a grant (written whole, then renamed over the old one). */
export function writeGrants(stateDir: string, name: string, g: Grants): void {
  const file = grantsPath(stateDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(g, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** What a package may use: what it declares and was granted, both. */
export function effective(declared: WidgetPermissions, granted: WidgetPermissions | null | undefined): WidgetPermissions {
  const out = noPermissions();
  for (const k of PERMISSION_KEYS) {
    const g = new Set(granted?.[k] ?? []);
    out[k] = declared[k].filter((x) => g.has(x));
  }
  return out;
}

/** Whether a package declares anything its grant doesn't have (a new host, program, folder, event class, any act). */
export function needsGrant(declared: WidgetPermissions, granted: WidgetPermissions | null | undefined): boolean {
  return PERMISSION_KEYS.some((k) => {
    const g = new Set(granted?.[k] ?? []);
    return declared[k].some((x) => !g.has(x));
  });
}
