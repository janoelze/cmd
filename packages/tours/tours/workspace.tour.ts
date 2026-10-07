// A workspace tour (Kai, persona.ts): a terminal in atlas, a Files window next to it in the
// grid, a README opened from its native context menu, a Magic widget build
// kicked off (a real model: meta.ai), then the palette to switch to the canvas
// while it builds.

import type { Tour } from "../src/driver.ts";
import type { TourMeta } from "../src/run.ts";
import { TYPING } from "../src/typing.ts";

export const meta: TourMeta = {
  ai: true,
};

export default async function (t: Tour) {
  const p = t.page;
  const main = p.getByRole("main");

  // A terminal, into the project.
  await t.click(p.getByRole("button", { name: "New…" }));
  await t.type("terminal", TYPING.field);
  await t.press("Return");
  await main.getByRole("textbox", { name: "Terminal input" }).waitFor();
  await t.pause(600);
  await t.type("cd ~/src/atlas && ls\n");
  await t.pause(1300);

  // Files, opened where the terminal is.
  await t.click(p.getByRole("button", { name: "New…" }));
  await t.type("files", TYPING.field);
  await t.press("Return");
  const files = p.getByRole("tree", { name: "Files" });
  await files.getByRole("treeitem", { name: "README.md", exact: true }).waitFor();
  await t.pause(500);

  // Side by side.
  await t.click(p.getByRole("button", { name: "Grid" }));
  await t.pause(900);

  // The README, from its native context menu.
  await t.click(files.getByRole("treeitem", { name: "README.md", exact: true }), { button: "right" });
  await t.menuItem("Open");
  await main.getByRole("group", { name: /README\.md/ }).waitFor();
  await t.pause(1500);

  // A widget, built by Magic from a sentence.
  await t.click(p.getByRole("button", { name: "New…" }));
  await t.type("a hacker shader: green code raining down a CRT", TYPING.field);
  const make = p.getByRole("option", { name: /^Make “a hacker shader/ });
  await make.waitFor();
  await t.pause(400);
  await t.click(make);
  await t.away();
  await t.pause(3500);

  // The palette, to the canvas.
  await t.click(p.getByRole("button", { name: "Command Palette" }));
  await t.type("canvas", TYPING.field);
  await p.getByRole("option", { name: "Canvas", exact: true, selected: true }).waitFor();
  await t.pause(300);
  await t.press("Return");
  await t.away();
  await t.pause(4000);
}
