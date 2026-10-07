// Kai's canvas: windows anywhere on an endless surface. Two-finger panning over
// empty canvas, ⌘-scroll to zoom out and see everything, ⇧⌘1 to fit, a window
// dragged to a new spot by its title, a double-click on a title to fly to it,
// and back to work in the terminal.

import type { Tour } from "../src/driver.ts";
import type { TourMeta } from "../src/run.ts";
import { TYPING } from "../src/typing.ts";

const call = (t: Tour, method: string, params: unknown) =>
  t.page.evaluate(([m, p]) => (window as unknown as { cmd: { call: (m: string, p: unknown) => Promise<unknown> } }).cmd.call(m as string, p), [method, params] as const);

export const meta: TourMeta = {
  // Unrecorded: a few windows on the canvas, fitted.
  setup: async (t) => {
    const p = t.page;
    const main = p.getByRole("main");
    await t.command("file.newTerminal");
    await main.getByRole("textbox", { name: "Terminal input" }).waitFor();
    await t.pause(500);
    await t.type("cd ~/src/atlas && clear && git log --oneline -4\n", TYPING.exact);
    await t.pause(400);
    await t.command("file.newFiles");
    await p.getByRole("tree", { name: "Files" }).getByRole("treeitem", { name: "README.md", exact: true }).waitFor();
    // On the canvas before opening more: in Focus a window opened from code isn't shown.
    await t.command("view.canvas");
    await t.pause(600);
    const home = await p.evaluate(() => (window as unknown as { cmd: { homeDir: string } }).cmd.homeDir);
    await call(t, "window.openTarget", { target: `${home}/src/atlas/README.md` });
    await call(t, "window.openTarget", { target: `${home}/notes/standup.md` });
    await main.getByRole("group", { name: /^standup\.md/ }).waitFor({ state: "attached" });
    await t.command("view.canvasFit");
    await t.pause(900);
  },
};

export default async function (t: Tour) {
  const p = t.page;
  const main = p.getByRole("main");
  await t.pause(500);

  // 1. Pan around with two fingers, over empty canvas.
  await t.pan(420, 220);
  await t.pause(400);
  await t.pan(-600, -120);
  await t.pause(400);

  // 2. Zoom out to see everything (⌘-scroll), then fit with ⇧⌘1.
  await t.zoom(-500);
  await t.pause(500);
  await t.press("1", "shift", "cmd");
  await t.pause(800);

  // 3. Move a window: drag the standup notes by their title.
  const notes = main.getByRole("group", { name: /^standup\.md/ });
  const terminal = main.getByRole("group", { name: /^zsh/ });
  await t.dragBy(notes.getByText(/^standup\.md$/).first(), -220, 140);
  await t.pause(500);

  // 4. Fly to a window: double-click its title.
  await t.click(terminal.getByText(/^zsh$/).first(), { clicks: 2 });
  await t.pause(800);

  // 5. Work there.
  await t.click(terminal);
  await t.type("git status --short && ls\n");
  await t.waitForText(terminal, /README\.md/);
  await t.away();
  await t.pause(1000);
}
