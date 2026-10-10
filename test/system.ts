// Shared by tests that wait on the real system: PTYs, shells, the procinfo helper,
// Deno, a browser, fs events. They run in vitest.config.ts's `system` project, a
// couple of files at a time, and every deadline they have comes from SYSTEM_TIMEOUT.
// A deadline only decides how long a broken test takes to say so, so it is sized
// for a machine that is busy with other suites, not for an idle one.
//
// needs(): a capability a test can't run without. Missing, the skip is printed with
// its reason; under CI (process.env.CI, which GitHub sets) it throws instead, so a
// runner without it can't report the suite green with whole areas untested.

import path from "node:path";

/** ms one wait on a real process may take (a shell's first prompt, a Deno build). A system test gets 3×. */
export const SYSTEM_TIMEOUT = 20_000;

/** Poll `fn` until it holds, failing with `what` after `ms`. */
export async function until(what: string, fn: () => unknown, ms = SYSTEM_TIMEOUT): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const said = new Set<string>();

/**
 * For `it.skipIf(needs(have, what))`: true (skip) when `have` is falsy, saying why.
 * `what` names the capability as the reason reads: "Deno (pnpm cmd magic install-runtime)".
 * With `optional`, CI doesn't install it either and only the skip is printed.
 */
export function needs(have: unknown, what: string, opts: { optional?: boolean } = {}): boolean {
  if (have) return false;
  const file = testFile();
  if (process.env.CI && !opts.optional) throw new Error(`${file} needs ${what}, which this CI machine lacks: install it in the workflow, or mark it optional in the test`);
  const line = `[skip] ${file}: ${what} is missing here, so the tests that need it don't run`;
  if (!said.has(line)) process.stderr.write(line + "\n");
  said.add(line);
  return true;
}

/** The test file that called needs(), from the stack. */
function testFile(): string {
  const at = new Error().stack?.split("\n").find((l) => /\.test\.[cm]?[jt]sx?/.test(l));
  const m = at?.match(/([^\s(/]+\.test\.[cm]?[jt]sx?)/);
  return m ? path.basename(m[1]!) : "a test";
}

/**
 * Do `act` now and again every `every` ms until `done` settles, failing after `ms`. For a
 * file write a watch must see: macOS starts an fs.watch's FSEvents stream on another thread,
 * so a write made before the stream is live is never reported (about one in three right
 * after the watch on a loaded machine, none once it is live). Repeating the write tests
 * that changes are reported without depending on how soon the stream starts.
 */
export async function repeating<T>(what: string, done: Promise<T>, act: () => void, every = 500, ms = SYSTEM_TIMEOUT): Promise<T> {
  act();
  let timer: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      done,
      new Promise<never>((_, reject) => {
        timer = setInterval(act, every);
        deadline = setTimeout(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    clearInterval(timer);
    clearTimeout(deadline);
  }
}
