// Magic's own entries on a package window made with Magic (docs/56, "Magic on V3"): Edit with
// Magic (a Magic window beside it asks what should change and builds it into the package) and
// Fix with Magic (it checks, tests and fixes it, told why it stopped if it did; the core knows).
// A package's window gets them first in its context
// menu (windows/package/register.tsx). Refresh Now and Mute aren't here: a package refreshes
// its own data (useData) and has no mute of its own yet.

import { parsePackageKind, type AppWindow } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import type { MenuEntry } from "../../lib/context.ts";
import { getState } from "../../lib/store.ts";

const edit = (w: AppWindow, fix?: boolean) => void cmd.call("magic.editPackage", { windowId: w.id, ...(fix ? { fix } : {}) }).catch((e: Error) => console.warn(`magic.editPackage: ${e.message}`));

/** Edit with Magic and Fix with Magic; nothing for a package Magic didn't make. */
export function magicPackageActions(w: AppWindow): MenuEntry[] {
  const pkg = parsePackageKind(w.kind);
  const entry = pkg && getState().library.find((e) => e.ref === w.kind);
  if (!entry?.magic) return [];
  return [{ label: "Edit with Magic…", run: () => edit(w) }, { label: "Fix with Magic", run: () => edit(w, true) }, "-"];
}
