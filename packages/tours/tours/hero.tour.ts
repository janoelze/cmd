// The hero: Kai's windows side by side in the strip, a Claude session started
// from New… joins its end, takes a task, and a Live Diff next to it shows the
// edits land; swipe along to watch, the sidebar says when it's done, swipe
// back to the terminal and commit. Real Claude Code on a real model (meta.ai):
// it waits on the work, not on time.

import type { Tour } from "../src/driver.ts";
import type { TourMeta } from "../src/run.ts";
import { TYPING } from "../src/typing.ts";

export const meta: TourMeta = {
  ai: true,
  // The agent's working time plays at 4× (its ends stay real-time); the camera zooms in on the work.
  post: { idle: 4, camera: "auto" },
  // Unrecorded: a terminal and Files in atlas, in the strip, from its start.
  setup: async (t) => {
    const p = t.page;
    const main = p.getByRole("main");
    await t.command("view.strip");
    await t.command("file.newTerminal");
    await main.getByRole("textbox", { name: "Terminal input" }).waitFor();
    await t.pause(500);
    await t.type("cd ~/src/atlas && clear && git log --oneline -4\n", TYPING.exact);
    await t.pause(500);
    await t.command("file.newFiles");
    await p.getByRole("tree", { name: "Files" }).getByRole("treeitem", { name: "README.md", exact: true }).waitFor();
    await t.pause(600);
    await t.scrollToStart(main);
    await t.pause(500);
  },
};

export default async function (t: Tour) {
  const p = t.page;
  const main = p.getByRole("main");
  await t.pause(500);

  // A Claude session, from New…: it joins the strip at the end.
  await t.click(p.getByRole("button", { name: "New…" }));
  await t.type("claude", TYPING.exact);
  await p.getByRole("option", { name: "Claude Session", selected: true }).waitFor();
  await t.press("Return");
  const claude = main.getByRole("group", { name: /claude/i }).last();
  await t.waitForText(claude, /\? for shortcuts|auto mode/i, 30_000);
  await t.pause(300);
  await t.type("make renderTrip render the stops it's given instead of the hardcoded string, and add a test. don't run anything", TYPING.field);
  await t.pause(250);
  await t.press("Return");
  await t.pause(600);

  // Live Diff next to it, on atlas.
  await t.click(p.getByRole("button", { name: "New…" }));
  await t.type("live diff", TYPING.exact);
  await p.getByRole("option", { name: /Live Diff/, selected: true }).waitFor();
  await t.press("Return");
  await t.pause(400);

  // Watch: swipe back to the agent, then along to the diff as it fills.
  const w = await t.windowBox();
  await t.moveTo({ x: w.x + w.width * 0.6, y: w.y + w.height * 0.55 });
  await t.swipe(-700);
  await t.pause(1200);
  const agents = p.getByRole("tree", { name: "Agents" });
  await agents.getByRole("treeitem").filter({ hasText: /Done|Finished/ }).first().waitFor({ timeout: 180_000 });
  await t.pause(500);
  await t.swipe(700);
  await t.pause(700);
  await t.hover(main.getByRole("group", { name: /^Changes/ }));
  await t.pause(1500); // read the diff

  // Back to the terminal (a long swipe), and commit.
  const shell = main.getByRole("group", { name: /^zsh/ });
  await t.click(shell);
  await t.type("git add -A && git commit -qm 'Render the real stops' && git log --oneline -3\n");
  await t.waitForText(shell, /Render the real stops/);
  await t.away();
  await t.pause(1500);
}
