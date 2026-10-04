// What's New after an update: the version the app last ran as, kept in the UI
// state dir. The first app window that asks after a launch learns which version
// to show changes since (renderer/src/components/WhatsNew.tsx); later windows
// and later asks get nothing, so the sheet opens once, in one window.

import fs from "node:fs";
import path from "node:path";

/** `after`: show releases newer than this; null: just the current one. */
export type WhatsNewClaim = { after: string | null } | null;

let claimed = false;

/**
 * @param existingUser the state dir was there before this launch, so a missing
 *   record means an update from a version before What's New, not a new install.
 * @param dev development builds record the version but never open the sheet.
 */
export function claimWhatsNew(dir: string, version: string, existingUser: boolean, dev: boolean): WhatsNewClaim {
  if (claimed) return null;
  claimed = true;
  const file = path.join(dir, "whats-new.json");
  let seen: string | null = null;
  try {
    seen = (JSON.parse(fs.readFileSync(file, "utf8")) as { seen?: string }).seen ?? null;
  } catch {}
  if (seen === version) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ seen: version }) + "\n");
  } catch {}
  if (dev) return null;
  if (seen === null) return existingUser ? { after: null } : null;
  return { after: seen };
}
