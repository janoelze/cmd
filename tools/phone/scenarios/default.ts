// The default scenario: a Mac with a bit of everything the phone shows. Home has a
// plain shell and one with a long build log to scroll; `api` has a Claude session
// asking for permission (Needs you) and one working; `site` one that's done, and
// htop (a full-screen program). Home also has a ticker that prints every second (to
// scroll up while output arrives) and an input probe that says whether what the phone
// sends arrives as a prompt or a paste (input-probe.mjs). The sessions are
// scripts/readme-shots/fake-claude.mjs, detected as Claude: it draws a fixed session and echoes what you type.

import type { ScenarioContext, Scenario } from "../src/scenario.ts";

export default (ctx: ScenarioContext): Scenario => ({
  description: "A shell, a long build log, a ticker, an input probe, Claude asking, working and done, and htop",
  workspaces: [
    {
      name: null,
      panes: [
        { name: "Shell" },
        { name: "Build log", command: "seq -f 'build step %g: compiled, 0 warnings' 1 800" },
        { name: "Ticker", command: "i=0; while :; do i=$((i+1)); echo \"tick $i: still printing, one line a second\"; sleep 1; done" },
        { name: "Input probe", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(`${ctx.root}/tools/phone/scenarios/input-probe.mjs`)}` },
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
