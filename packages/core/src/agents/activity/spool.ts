// The hook's spool: besides the per-event status files, cmd's hook links every
// event into <status root>/<pane>/log/ under a name of its own, so none are
// overwritten. The core takes them in order (by write time) and deletes them once
// stored. Files are complete when they appear (linked after writing); dot files
// are still being written.

import fs from "node:fs";
import path from "node:path";
import type { PaneId } from "@cmd/protocol";
import type { RawEvent } from "./normalize.ts";

export const spoolDir = (root: string, paneId: PaneId) => path.join(root, paneId, "log");

/** Reads and removes a pane's spooled events, oldest first. `bad`: names of files that weren't events. */
export function drainSpool(root: string, paneId: PaneId): { events: RawEvent[]; bad: string[] } {
  const dir = spoolDir(root, paneId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { events: [], bad: [] };
  }
  const found: { ev: RawEvent; ns: bigint; name: string }[] = [];
  const bad: string[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const file = path.join(dir, name);
    try {
      const ns = fs.statSync(file, { bigint: true }).mtimeNs;
      const root = JSON.parse(fs.readFileSync(file, "utf8")) as { agent?: unknown; ts?: unknown; env?: unknown; event?: unknown };
      const payload = root.event;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const p = payload as Record<string, unknown>;
        const env = root.env && typeof root.env === "object" ? (Object.fromEntries(Object.entries(root.env).filter(([, v]) => typeof v === "string" && v)) as Record<string, string>) : undefined;
        found.push({
          ev: {
            at: Number(ns / 1000n) / 1000,
            agent: typeof root.agent === "string" && root.agent ? root.agent : null,
            name: typeof p.hook_event_name === "string" ? p.hook_event_name : (name.split(".")[2] ?? "unknown"),
            payload: p,
            ...(env && Object.keys(env).length ? { env } : {}),
          },
          ns,
          name,
        });
      } else bad.push(name);
    } catch {
      bad.push(name);
    }
    fs.rmSync(file, { force: true });
  }
  found.sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : a.name < b.name ? -1 : 1));
  return { events: found.map((f) => f.ev), bad };
}
