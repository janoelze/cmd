// The fake host's fixtures (@cmd/widget-api/testing) against the core's own mapping
// (widgets/api/model.ts): an agent a widget's test makes looks as the core would send it, in
// every state and for every kind (drift: the fixtures once gave Codex the icon "terminal").
import { describe, expect, it } from "vitest";
import type { Agent } from "@cmd/protocol";
import { apiAgent } from "../packages/core/src/widgets/api/model.ts";
import { fixtures } from "../packages/widget-api/src/testing/fixtures.ts";

const STATES: Agent["state"][] = ["starting", "working", "idle", "needs_input", "done", "exited", "failed"];

describe("widget fixtures", () => {
  it("an agent's bucket, light and icon are the core's for each state and kind", () => {
    for (const kind of ["claude", "codex", "gemini"])
      for (const state of STATES) {
        // Not looked at since it changed: a done agent is unseen, as a fixture's is.
        const core = apiAgent({ id: "a", kind, state, stateSince: 2, seenAt: 1, cwd: "/x", workspaceId: "ws-1", paneId: "p", parentId: null, depth: 0, name: null, detail: null } as unknown as Agent, () => null);
        const fake = fixtures.agent({ kind, state: core.state });
        expect({ bucket: fake.bucket, light: fake.light, icon: fake.icon }, `${kind} ${state}`).toEqual({ bucket: core.bucket, light: core.light, icon: core.icon });
      }
  });
});
