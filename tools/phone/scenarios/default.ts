// The default scenario: a Mac with a bit of everything the phone shows. Home has a
// plain shell and one with a long build log to scroll; `api` has a Claude session
// asking for permission (Needs you) and one working; `site` one that's done, and
// htop (a full-screen program). The sessions are scripts/readme-shots/fake-claude.mjs,
// detected as Claude: it draws a fixed session and echoes what you type.

import type { ScenarioContext, Scenario } from "../src/scenario.ts";

export default (ctx: ScenarioContext): Scenario => ({
  description: "A shell, a long build log, Claude asking, working and done, and htop",
  workspaces: [
    {
      name: null,
      panes: [
        { name: "Shell" },
        { name: "Build log", command: "seq -f 'build step %g: compiled, 0 warnings' 1 800" },
      ],
    },
    {
      name: "api",
      panes: [
        { name: "Claude, needs you", ...ctx.claude("ask", ctx.work("api")) },
        { name: "Claude, working", ...ctx.claude("working", ctx.work("api")) },
      ],
    },
    {
      name: "site",
      panes: [
        { name: "Claude, done", ...ctx.claude("done", ctx.work("site")) },
        { name: "htop", command: `${ctx.bin}/htop` },
      ],
    },
  ],
});
