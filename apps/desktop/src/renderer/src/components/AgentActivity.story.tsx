// Workbench stories (pnpm workbench agentactivity): the Agent Activity widget with
// stand-in agents: one waiting, two working with a subagent, some finished; every
// workspace; none; every size.

import { AllSizes, RefWindow, type SizeName } from "../reference/RefWindow.tsx";
import { AgentActivityView, type ActivityLine } from "./AgentActivity.tsx";

const noop = () => {};
const line = (key: string, name: string, light: ActivityLine["light"], status: string | undefined, place: string, time: string, depth = 0, needs = false): ActivityLine => ({ key, depth, icon: "sparkle", light, name, status, place, time, needs, onClick: noop });

const LINES = [
  line("a", "Claude · window design", "needs", "Wants to run pnpm e2e", "cmd-migrate-widgets", "2m", 0, true),
  line("b", "Claude · session names", "working", "Editing packages/core/src/agents/tracker.ts", "cmd-session-names", "now"),
  line("c", "Explore · find the tracker's callers", "working", "Searching", "cmd-session-names", "now", 1),
  line("d", "Codex · sqlite viewer", "working", "Running the tests", "cmd-sqlite", "4m"),
  line("e", "Claude · release notes", "done", "Done: wrote the 0.23 notes", "cmd", "1h"),
  line("f", "Claude · triage crashes", undefined, undefined, "cmd", "3h"),
];

function W({ size = "regular", lines = LINES, scope = "workspace" }: { size?: SizeName; lines?: ActivityLine[]; scope?: "all" | "workspace" }) {
  return (
    <RefWindow icon="person.2" name="Agent Activity" size={size}>
      <AgentActivityView lines={lines} scope={scope} onNew={noop} />
    </RefWindow>
  );
}

export const Default = () => <W />;
export const AllWorkspaces = () => <W scope="all" lines={LINES.map((l) => ({ ...l, place: `Work · ${l.place}` }))} />;
export const Empty = () => <W lines={[]} />;
export const Sizes = () => <AllSizes render={(s) => <W size={s} />} />;
