// Run Scripts' states for the UI Workbench (`pnpm workbench widgets/actions`): the widget against
// the fake host, one variant per state, each the host's data.

import type { HostData } from "@cmd/widget-api/testing/host";
import { command, pane } from "@cmd/widget-api/testing/fixtures";
import RunScripts from "./actions.tsx";

export default RunScripts;

const actions = [
  { name: "dev", title: "Starts the dev server with hot reload", risky: false },
  { name: "test", title: "Runs the unit tests", risky: false },
  { name: "typecheck", title: "Checks the types of every package", risky: false },
  { name: "e2e", title: "Drives the built app through its scenarios", risky: false },
  { name: "build", title: "Builds the app", risky: false },
  { name: "release", title: "Tags a version and pushes it", risky: true },
];
const ago = (ms: number) => Date.now() - ms;

/** A project's scripts, nothing run yet from here. */
export const Scripts: HostData = { actions, terminals: [pane()] };

/** The dev server running, the tests failed. */
export const Running: HostData = {
  actions,
  terminals: [pane(), pane({ id: "t-dev" }), pane({ id: "t-test" })],
  events: [command({ command: "pnpm dev", ago: 4 * 60_000, terminalId: "t-dev" }), command({ command: "pnpm test", ago: 90_000, took: 6200, exitCode: 1, terminalId: "t-test" })],
  state: { ran: { dev: { terminalId: "t-dev", at: ago(4 * 60_000 + 500) }, test: { terminalId: "t-test", at: ago(90_500) } } },
};

/** Many scripts: a filter in the toolbar. */
export const Many: HostData = { actions: [...actions, ...Array.from({ length: 12 }, (_, i) => ({ name: `docs:${["build", "serve", "check", "lint"][i % 4]}-${i}`, title: "make docs", risky: false }))] };

/** In a narrow window, as in a sidebar. */
export const Narrow: HostData & { size: "narrow" } = { ...Running, size: "narrow" };

/** A folder with nothing to run. */
export const Empty: HostData = { actions: [] };

/** A workspace without a folder. */
export const NoFolder: HostData = { workspace: { root: null } };
