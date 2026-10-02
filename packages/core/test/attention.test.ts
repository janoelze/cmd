import { describe, expect, it } from "vitest";
import { sortRows, type Agent, type Pane } from "@cmd/protocol";

const pane = (id: string, lastActivityAt: number): Pane => ({
  id, title: id, cwd: "/", shell: "zsh", pid: 1, foreground: "zsh", cols: 80, rows: 24,
  createdAt: 0, lastActivityAt, exitCode: null, agentId: null, usage: null,
});
const agent = (state: Agent["state"], stateSince: number, seenAt: number | null = null) =>
  ({ id: "a", state, stateSince, seenAt } as Agent);

describe("sortRows", () => {
  it("puts needs-input first (longest wait first), then unseen done, then recency", () => {
    const rows = [
      { pane: pane("recent-shell", 900), agent: null },
      { pane: pane("seen-done", 100), agent: agent("done", 50, 60) },
      { pane: pane("needs-new", 0), agent: agent("needs_input", 300) },
      { pane: pane("unseen-done", 0), agent: agent("done", 200) },
      { pane: pane("needs-old", 0), agent: agent("needs_input", 100) },
      { pane: pane("old-shell", 10), agent: null },
    ];
    expect(sortRows(rows).map((r) => r.pane.id)).toEqual([
      "needs-old", "needs-new", "unseen-done", "recent-shell", "seen-done", "old-shell",
    ]);
  });
});
