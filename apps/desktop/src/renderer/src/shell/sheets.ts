// What sits over the board: one sheet at a time (the command palette, a picker, onboarding,
// the Widget Library, What's New, Feedback, the Task Manager), opened by commands from anywhere
// and closed by ⌘W. A sheet that shouldn't interrupt (What's New after a launch) waits its turn
// behind the one open. Onboarding's steps count as seen when it goes, done or not.

import { useSyncExternalStore } from "react";
import type { Release } from "../../../shared/changelog.ts";
import { cmd } from "../lib/bridge.ts";
import type { QuickPending } from "./quick/quick.ts";
import type { Picker } from "./workspaces.tsx";

export type Sheet =
  /** The palette, with what is typed in it ("?" for search, docs/33). */
  | { kind: "palette"; query: string }
  | { kind: "picker"; picker: Picker }
  /** Onboarding (onboarding/Onboarding.tsx), at these steps. */
  | { kind: "setup"; ids: readonly string[] }
  | { kind: "library" }
  | { kind: "whatsNew"; releases: Release[] }
  | { kind: "feedback" }
  | { kind: "taskManager" }
  /** A Quick Command that asks for values or a yes before it runs (docs/58). */
  | { kind: "quick"; pending: QuickPending };

let sheet: Sheet | null = null;
/** Sheets waiting for the open one to close, first first. */
let waiting: Sheet[] = [];
const listeners = new Set<() => void>();

function set(next: Sheet | null): void {
  if (sheet?.kind === "setup" && next !== sheet) cmd.onboardingSeen([...sheet.ids]);
  sheet = next;
  for (const fn of listeners) fn();
}

export function currentSheet(): Sheet | null {
  return sheet;
}

/** Open it in place of the one open. */
export function openSheet(next: Sheet): void {
  set(next);
}

/** Open it, or close it if it is the one open (⌘K, ⌘N, ⇧⌘L). */
export function toggleSheet(next: Sheet, same: (s: Sheet) => boolean = (s) => s.kind === next.kind): void {
  if (sheet && same(sheet)) closeSheet();
  else set(next);
}

/** Open it once nothing else is (What's New after onboarding). */
export function queueSheet(next: Sheet): void {
  if (sheet) waiting.push(next);
  else set(next);
}

/** Close the open sheet; the next waiting one shows. */
export function closeSheet(): void {
  const [next = null, ...rest] = waiting;
  waiting = rest;
  set(next);
}

export function useSheet(): Sheet | null {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => sheet,
  );
}
