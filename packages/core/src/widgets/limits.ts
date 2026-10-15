// Widgets' limits in one place (docs/56): how long a widget process may be quiet, how much it may
// use and log, how a burst of saves is gathered, and how long and how far a Magic build goes and
// what it reads and draws. The CLI's `cmd widget` waits come from here too. The verbs' own
// limits (cmd.run, cmd.net, cmd.ai, acts) stay beside their verbs in widgets/api/.

import type { HostTimes } from "./host/host.ts";
import type { LogLimitOptions } from "./host/log-limit.ts";

// ── a widget's process (host/) ───────────────────────────

/** Ping every 5 s, stalled after 20 s quiet; a closed window's process lives 60 s; hello within 20 s; 3 crashes in 5 min stop it; a restart waits 1 s. */
export const HOST_TIMES: HostTimes = { pingMs: 5000, stallMs: 20_000, stopAfterMs: 60_000, helloMs: 20_000, crashWindowMs: 5 * 60_000, maxCrashes: 3, restartMs: 1000 };
/** The heap limit of a widget process (MB). */
export const WIDGET_MEMORY_MB = 256;
/** Its console to clients: about 50 lines a second, 100 at once, the dropped count said a second after the first drop. */
export const LOG_LIMIT: LogLimitOptions = { rate: 50, burst: 100, reportMs: 1000 };

// ── bursts ───────────────────────────────────────────────

/** After a save in a package's sources, how long to wait for the rest of its burst before one reload (ms; reload.ts, `cmd widget dev`'s package.json). */
export const RELOAD_DEBOUNCE_MS = 250;
/** After a change in the packages folder, how long before it is read again (ms; packages.ts). */
export const PACKAGES_DEBOUNCE_MS = 100;
/** Changes to the Library in a burst go to clients once, this long after the first (ms; library.ts). */
export const LIBRARY_DEBOUNCE_MS = 50;
/** How long `cmd widget link`, `unlink` and `dev` wait for the Library to list (or drop) a package (ms). */
export const LIBRARY_WAIT_MS = 5000;

// ── Magic's build (magic/package/) ───────────────────────

/** Steps the agent takes in its first turn. */
export const BUILD_STEPS = 40;
/** Times cmd's verify sends problems back to the agent. */
export const BUILD_REPAIRS = 2;
/** Steps the agent takes in each of those turns. */
export const REPAIR_STEPS = 15;
/** One TypeScript or Vitest run of the toolchain (ms). */
export const TOOLCHAIN_TIMEOUT_MS = 90_000;
/** The app's previewer answers a batch within this, else the build goes on without shots (ms). */
export const PREVIEW_TIMEOUT_MS = 60_000;
/** The largest package file the agent writes, or that is read back for it (bytes). */
export const MAX_FILE = 256 * 1024;
/** States of a story (else fixtures) rendered per widget. */
export const STORY_STATES = 6;
/** Other states drawn for the agent after the first's two draws (narrow, wide). */
export const PREVIEW_STATES = 3;
/** Screenshots the agent gets from one preview. */
export const AGENT_SHOTS = 4;
