// Payload upcasters (docs/28 §7): a stored row keeps the `v` it was written
// with; readers see the current shape. Changing a payload means raising its
// EVENT_V and adding one function here per step, version n → n+1 at index n-1,
// so a row of any older version can be brought up to date. The store applies
// them in toEvent; nothing rewrites rows. A test fails when an EVENT_V above 1
// has fewer than EVENT_V - 1 upcasters.

import { EVENT_V, type DataEventType } from "@cmd/protocol";

export type Upcaster = (data: unknown) => unknown;

/** Per type, the steps from version 1 up: [v1 → v2, v2 → v3, …]. */
export const UPCASTERS: Partial<Record<DataEventType, Upcaster[]>> = {};

/** A stored payload in the current shape of its type, with the version it is in now. */
export function upcast(type: string, v: number, data: unknown, table: Partial<Record<string, Upcaster[]>> = UPCASTERS, current: Partial<Record<string, number>> = EVENT_V): { v: number; data: unknown } {
  const to = current[type] ?? v;
  const steps = table[type] ?? [];
  while (v < to && steps[v - 1]) data = steps[v - 1]!(data), v++;
  return { v, data };
}
