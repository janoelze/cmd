// Workbench stories (pnpm workbench actionsview): the Workspace Actions widget,
// Actions with stand-in lists, every state: running and idle, a long list with its
// filter, describing, AI not set up, a file it can't read, a run in another
// checkout, nothing to run, no folder, loading, an error, and every size.

import type { ActionRun, ActionsList, PaneId, WorkspaceAction } from "@cmd/protocol";
import { AllSizes, RefWindow, type SizeName } from "../reference/RefWindow.tsx";
import { Actions, type ActionsProps } from "./ActionsView.tsx";

const NOW = Date.now();
const pane = (n: number) => `p${n}` as PaneId;
const act = (name: string, kind: WorkspaceAction["kind"], o: Partial<WorkspaceAction> = {}): WorkspaceAction => ({
  id: `npm:package.json:${name}`,
  name,
  command: `pnpm ${name}`,
  cwd: "/Users/jan/src/cmd",
  source: { kind: "npm", file: "package.json" },
  kind,
  long: false,
  risky: false,
  ...o,
});

const ACTIONS: WorkspaceAction[] = [
  act("dev", "dev", { long: true, description: "Electron with hot reload; starts a core if none is running" }),
  act("test", "test", { description: "Vitest, all packages" }),
  act("e2e", "test", { description: "Build, then drive the real app with Playwright" }),
  act("e2e:motion", "test", { description: "Score jumps, snaps and wobble frame by frame" }),
  act("build", "build", { description: "Bundle the desktop app" }),
  act("dist", "build", { description: "Package a signed cmd dev build" }),
  act("typecheck", "check", { description: "tsc for the packages and the desktop app" }),
  act("ui", "run", { long: true, description: "The @cmd/ui gallery in a browser" }),
  act("release", "deploy", { risky: true, description: "Bump, tag and push; CI publishes the release" }),
  act("prototype", "agent", { agent: "claude", command: "/prototype", source: { kind: "skills", file: ".claude/skills/prototype/SKILL.md" }, description: "Iterate on UI in the Workbench" }),
];
const MORE: WorkspaceAction[] = ["core", "core:stop", "tokens", "design-debt", "workbench", "tour", "shots"].map((n) => act(n, "run", { description: `pnpm ${n}` }));
const HISTORY: WorkspaceAction[] = [act("vitest run packages/core", "test", { id: "history:vitest", command: "pnpm vitest run packages/core", source: { kind: "history", file: "" }, history: { runs: 14 } })];

const run = (actionId: string, o: Partial<ActionRun>): ActionRun => ({ actionId, paneId: pane(1), startedAt: NOW - 252_000, endedAt: null, exitCode: null, url: null, ...o });
const RUNS: ActionRun[] = [
  run(ACTIONS[0]!.id, { url: "http://localhost:5173/" }),
  run(ACTIONS[1]!.id, { paneId: pane(2), startedAt: NOW - 600_000, endedAt: NOW - 562_000, exitCode: 0 }),
  run(ACTIONS[2]!.id, { paneId: pane(3), startedAt: NOW - 900_000, endedAt: NOW - 700_000, exitCode: 1 }),
];

const list = (o: Partial<ActionsList> = {}): ActionsList => ({
  root: "/Users/jan/src/cmd",
  actions: ACTIONS,
  history: HISTORY,
  suggested: [],
  primary: ACTIONS[0]!.id,
  sources: [{ file: "package.json" }],
  runs: RUNS,
  checkout: { project: "/Users/jan/src/cmd", top: "/Users/jan/src/cmd-migrate-actions", linked: true, branch: "migrate-actions" },
  worktrees: [],
  elsewhere: [],
  describing: false,
  ...o,
});

const noop = () => {};
const base: ActionsProps = { root: "/Users/jan/src/cmd", list: list(), error: null, now: NOW, toggled: new Set(), onToggle: noop, showWhere: false, offerAi: false, onSetUpAi: noop, onRun: noop, onStop: noop, onMenu: noop, onOpenUrl: noop, onShow: noop };

function W({ size = "regular", ...p }: Partial<ActionsProps> & { size?: SizeName }) {
  return (
    <RefWindow icon="play.rectangle" name="Workspace Actions · cmd" size={size}>
      <Actions {...base} {...p} />
    </RefWindow>
  );
}

export const Default = () => <W />;
export const Sizes = () => <AllSizes render={(s) => <W size={s} />} />;
export const Idle = () => <W list={list({ runs: [] })} />;
/** More than 12: the filter shows in a toolbar. */
export const Many = () => <W list={list({ actions: [...ACTIONS, ...MORE] })} />;
export const Filtered = () => <W list={list({ actions: [...ACTIONS, ...MORE] })} initialQuery="e2e" />;
export const NoMatches = () => <W list={list({ actions: [...ACTIONS, ...MORE] })} initialQuery="deploy prod" />;
export const Describing = () => <W list={list({ describing: true })} />;
export const OfferAi = () => <W list={list({ actions: ACTIONS.map((a) => ({ ...a, description: undefined })) })} offerAi />;
export const OtherCheckout = () => <W showWhere />;
export const SourceError = () => <W list={list({ sources: [{ file: "package.json" }, { file: "justfile", error: "Line 12: a recipe without a body." }] })} />;
export const RunningElsewhere = () => <W list={list({ runs: [], elsewhere: [{ ...run(ACTIONS[0]!.id, { url: "http://localhost:5174/" }), root: "/Users/jan/src/cmd-sqlite", branch: "sqlite-viewer" }] })} />;
export const NothingToRun = () => <W list={list({ actions: [], history: [], primary: null, runs: [] })} />;
export const NoFolder = () => <W root={null} list={null} />;
export const Loading = () => <W list={null} />;
export const Failed = () => <W list={null} error="EACCES: permission denied, open '/Users/jan/src/cmd/package.json'" />;
