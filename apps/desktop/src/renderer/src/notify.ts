// Whether and how the UI shows a notification (App.tsx). The core decides what
// is worth telling (packages/core/src/notifications.ts); here, whether you've
// already seen it (Looks: an agent that finished while or just after you
// watched it) and how agents that finish close together become one
// notification instead of several (DoneBatch).

/** An agent that finished within this long after you looked away: you saw it end. */
export const SAW_IT_MS = 30_000;
/** Agents that finish within this long of each other share one notification. */
export const DONE_BATCH_MS = 120_000;
/** The tag of the notification that sums them up (one per window, replaced in place). */
export const DONE_TAG = "agents-done";
/** Names listed in the sum before "and N more". */
const NAMES_MAX = 3;

/** What you look at (selected with the app focused) and when you stopped looking at each window. */
export class Looks {
  #now: string | null = null;
  #ended = new Map<string, number>();

  /** The window on screen in the focused app, or null when the app isn't focused. */
  look(id: string | null, at = Date.now()): void {
    if (this.#now === id) return;
    if (this.#now) this.#ended.set(this.#now, at);
    this.#now = id;
  }

  now(id: string): boolean {
    return this.#now === id;
  }

  /** Looking at it now, or were within `ms` before `at`. */
  saw(id: string, at: number, ms = SAW_IT_MS): boolean {
    return this.#now === id || (this.#ended.get(id) ?? -Infinity) >= at - ms;
  }
}

export interface Shown {
  tag: string;
  title: string;
  body: string;
  /** Earlier notifications this one replaces (their tags), to close. */
  replaces: string[];
}

/** Agents that finished recently, to sum up the next one with them. */
export class DoneBatch {
  #recent: { tag: string; name: string; at: number }[] = [];

  /** The notification for an agent that finished: its own, or one for all that finished within DONE_BATCH_MS. */
  add(n: { tag: string; name: string; title: string; body: string; at: number }): Shown {
    this.#recent = this.#recent.filter((r) => r.at >= n.at - DONE_BATCH_MS && r.tag !== n.tag);
    const before = this.#recent.map((r) => r.tag);
    this.#recent.push({ tag: n.tag, name: n.name, at: n.at });
    if (!before.length) return { tag: n.tag, title: n.title, body: n.body, replaces: [] };
    const names = [...new Set(this.#recent.map((r) => r.name).reverse())];
    return { tag: DONE_TAG, title: `${this.#recent.length} agents · done`, body: list(names), replaces: before };
  }

  /** You looked at it: the next sum leaves it out. */
  seen(tag: string): void {
    this.#recent = this.#recent.filter((r) => r.tag !== tag);
  }
}

/** "a, b and c", "a, b, c and 2 more". */
function list(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length <= NAMES_MAX) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, NAMES_MAX).join(", ")} and ${names.length - NAMES_MAX} more`;
}
