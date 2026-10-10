// Two projects. `unit`: everything that runs in-process (fakes, SQLite, sockets),
// fully parallel. `system`: files that wait on real processes (PTYs and shells, the
// procinfo helper, Deno, sandbox-exec, Chromium), two at a time, with deadlines from
// SYSTEM_TIMEOUT (test/system.ts): run in parallel with all the rest they starve each
// other and fail under load while passing alone. Vitest runs projects with different
// maxWorkers one after the other (groupOrder): the quick unit run first, then system.
// `pnpm vitest run --project unit` or `--project system` runs one.
import { defineConfig } from "vitest/config";
import { SYSTEM_TIMEOUT } from "./test/system.ts";

const ALL = ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "website/test/**/*.test.ts"];
const SYSTEM = [
  "core",
  "deno-install",
  "hooks",
  "lock",
  "loginpath",
  "magic",
  "pty-leak",
  "resources",
  "shells",
  "sqlite",
  "widgets",
].map((f) => `packages/core/test/${f}.test.ts`).concat("packages/ui/test/dialog.test.ts");

export default defineConfig({
  test: {
    testTimeout: 15000,
    setupFiles: ["./vitest.setup.ts"],
    // node:sqlite warns once per worker that it is experimental: noise that hides a real warning.
    execArgv: ["--disable-warning=ExperimentalWarning"],
    // expect.poll waits on sockets and crypto in-process (remote, relay): its default 1 s failed under load.
    expect: { poll: { timeout: SYSTEM_TIMEOUT / 2 } },
    projects: [
      { extends: true, test: { name: "unit", include: ALL, exclude: SYSTEM, sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: "system", include: SYSTEM, sequence: { groupOrder: 1 }, maxWorkers: 2, testTimeout: 3 * SYSTEM_TIMEOUT, hookTimeout: 3 * SYSTEM_TIMEOUT } },
    ],
  },
});
