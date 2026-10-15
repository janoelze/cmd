// __TITLE__'s states for the UI Workbench (`pnpm workbench widgets/__NAME__`) and for
// `cmd widget preview`: the widget is the default export, each other export one state, as
// the fake host's data (`size` picks the window's size). A line of comment above each says
// what it shows.

import type { HostData } from "@cmd/widget-api/testing/host";
import { pane } from "@cmd/widget-api/testing/fixtures";
import Terminals from "./widget.tsx";

export default Terminals;

const busy = [
  pane({ title: "dev server", command: "pnpm dev", cwd: "/Users/me/src/api" }),
  pane({ title: "tests", command: "pnpm test --watch" }),
  pane({ title: "claude", command: "claude", agentId: "a-claude" }),
  pane({ title: "zsh" }),
  pane({ title: "logs", cwd: "/var/log" }),
];

/** Three busy terminals first, then two at a prompt; "3 running" in the title bar. */
export const Busy: HostData = { terminals: busy };

/** "pnpm test" pinned (in another window, or another workspace): it comes first. */
export const Pinned: HostData = { terminals: busy, storage: { package: { pinned: ["pnpm test --watch"] } } };

/** In a narrow window, as in a sidebar. */
export const Narrow: HostData & { size: "narrow" } = { terminals: busy, size: "narrow" };

/** The filter matches nothing: a way back to all of them. */
export const NoMatches: HostData = { terminals: busy, state: { query: "nothing like it" } };

/** No terminals in this workspace yet. */
export const Empty: HostData = { terminals: [] };
