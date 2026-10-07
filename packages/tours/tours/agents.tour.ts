// Kai hands a change to Claude Code and watches it land: a Claude session from
// New…, the task typed in, the sidebar following it (working, done), a Live
// Diff widget showing the edits as they happen, and a commit from a terminal
// when it's done. A real Claude Code on a real model (meta.ai): the words and
// the edits differ a little every run; the tour waits on them, not on time.

import type { Tour } from "../src/driver.ts";
import type { TourMeta } from "../src/run.ts";
import { TYPING } from "../src/typing.ts";

export const meta: TourMeta = {
  ai: true,
  // Unrecorded: a terminal in atlas, where the session will start.
  setup: async (t) => {
    await t.command("file.newTerminal");
    await t.page.getByRole("main").getByRole("textbox", { name: "Terminal input" }).waitFor();
    await t.pause(500);
    await t.type("cd ~/src/atlas && clear\n", TYPING.exact);
    await t.pause(500);
  },
};

export default async function (t: Tour) {
  const p = t.page;
  const main = p.getByRole("main");
  await t.pause(700);

  // A Claude session, from New….
  await t.click(p.getByRole("button", { name: "New…" }));
  await t.type("claude", TYPING.exact);
  await p.getByRole("option", { name: "Claude Session", selected: true }).waitFor();
  await t.press("Return");
  const claude = main.getByRole("group", { name: /claude/i }).last();
  await t.waitForText(claude, /\? for shortcuts|auto mode/i, 30_000);
  await t.pause(600);

  // The task.
  await t.type("make renderTrip render the stops it's given instead of the hardcoded string, and add a test for it. don't run anything", TYPING.field);
  await t.pause(500);
  await t.press("Return");
  await t.pause(1500);

  // The edits as they happen: Live Diff, next to the session.
  await t.click(p.getByRole("button", { name: "New…" }));
  await t.type("live diff", TYPING.exact);
  await p.getByRole("option", { name: /Live Diff/, selected: true }).waitFor();
  await t.press("Return");
  await t.click(p.getByRole("button", { name: "Grid" }));
  await t.away();

  // Done: the sidebar says so.
  const agents = p.getByRole("tree", { name: "Agents" });
  await agents.getByRole("treeitem").filter({ hasText: /Done|Finished/ }).first().waitFor({ timeout: 180_000 });
  await t.pause(2500);

  // Commit it, from the terminal.
  const shell = main.getByRole("group", { name: /^zsh/ });
  await t.click(shell);
  await t.type("git add -A && git commit -qm 'Render the real stops' && git log --oneline -3\n");
  await t.waitForText(shell, /Render the real stops/);
  await t.pause(2500);
}
