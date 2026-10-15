// Run Scripts' states for the UI Workbench (`pnpm workbench widgets/actions`): the widget against
// the fake host, one variant per state, each the host's data.

import type { HostData } from "@cmd/widget-api/testing/host";
import { command, pane } from "@cmd/widget-api/testing/fixtures";
import type { WorkspaceAction } from "@cmd/widget-api";
import RunScripts from "./actions.tsx";

export default RunScripts;

const act = (over: Partial<WorkspaceAction> & { name: string }): WorkspaceAction => ({ title: over.name, risky: false, command: `pnpm ${over.name}`, kind: "run", package: null, pinned: false, primary: false, running: false, terminalId: null, url: null, exitCode: null, ...over });
const actions = [
  act({ name: "dev", title: "Starts the dev server with hot reload", kind: "dev", primary: true }),
  act({ name: "test", title: "Runs the unit tests", kind: "test" }),
  act({ name: "typecheck", title: "Checks the types of every package", kind: "check" }),
  act({ name: "e2e", title: "Drives the built app through its scenarios", kind: "test", pinned: true }),
  act({ name: "build", title: "Builds the app", kind: "build" }),
  act({ name: "release", title: "Tags a version and pushes it", kind: "deploy", risky: true }),
];

/** A project's scripts, nothing run yet. */
export const Scripts: HostData = { actions, terminals: [pane()] };

/** The dev server running at its address (started anywhere), the tests failed. */
export const Running: HostData = {
  actions: actions.map((a) => (a.name === "dev" ? { ...a, running: true, terminalId: "t-dev", url: "http://localhost:5173/" } : a.name === "test" ? { ...a, terminalId: "t-test", exitCode: 1 } : a)),
  terminals: [pane(), pane({ id: "t-dev" }), pane({ id: "t-test" })],
  events: [command({ command: "pnpm dev", ago: 4 * 60_000, terminalId: "t-dev" }), command({ command: "pnpm test", ago: 90_000, took: 6200, exitCode: 1, terminalId: "t-test" })],
};

/** Many scripts: a filter in the toolbar. */
export const Many: HostData = { actions: [...actions, ...Array.from({ length: 12 }, (_, i) => act({ name: `docs:${["build", "serve", "check", "lint"][i % 4]}-${i}`, title: "make docs", kind: ["build", "dev", "check", "check"][i % 4]! }))] };

/** In a narrow window, as in a sidebar. */
export const Narrow: HostData & { size: "narrow" } = { ...Running, size: "narrow" };

/** A folder with nothing to run. */
export const Empty: HostData = { actions: [] };

/** A workspace without a folder. */
export const NoFolder: HostData = { workspace: { root: null } };
