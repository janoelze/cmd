// Website loops (1:1) of the command palette: running commands from it, and
// searching past agent sessions with ?. Each shot ends where it started.

import type { Tour } from "../src/driver.ts";
import type { TourMeta } from "../src/run.ts";
import { TYPING } from "../src/typing.ts";

/** ⌘K, a query, wait for the option, Return. */
async function run(t: Tour, query: string, option: string) {
  await t.press("k", "cmd");
  await t.page.getByRole("combobox").waitFor();
  await t.type(query, TYPING.exact, { stay: true });
  await t.page.getByRole("option", { name: option, exact: true, selected: true }).waitFor();
}

export const meta: TourMeta = {
  // Unrecorded: Kai's terminal in atlas, Files beside it, and a palette that's been used.
  setup: async (t) => {
    const p = t.page;
    await t.command("file.newTerminal");
    await p.getByRole("main").getByRole("textbox", { name: "Terminal input" }).waitFor();
    await t.pause(400);
    await t.type("cd ~/src/atlas && clear && git log --oneline -3\n", TYPING.exact);
    await t.command("file.newFiles");
    await p.getByRole("tree", { name: "Files" }).getByRole("treeitem", { name: "README.md", exact: true }).waitFor();
    for (const [q, o] of [["grid", "Grid"], ["strip", "Strip"], ["focus", "Focus"]] as const) {
      await run(t, q, o);
      await t.press("Return");
      await t.pause(300);
    }
    await t.away();
  },
};

export default async function (t: Tour) {
  const p = t.page;
  const palette = p.getByRole("dialog", { name: "Command Palette" });

  // Commands: to the grid and back.
  await t.shot.start("palette", { region: [palette], pad: 56 });
  await t.pause(600);
  await run(t, "grid", "Grid");
  await t.pause(500);
  await t.press("Return");
  await t.pause(1000);
  await run(t, "focus", "Focus");
  await t.pause(500);
  await t.press("Return");
  await t.pause(800);
  await t.loopBack();
  await t.shot.end("palette");

  // Searching past sessions: ?offline, the hits with their snippets, Escape.
  await t.shot.start("palette-search", { region: [palette], pad: 56 });
  await t.pause(600);
  await t.press("k", "cmd");
  await p.getByRole("combobox").waitFor();
  await t.type("?offline", TYPING.exact, { stay: true });
  await p.getByRole("option", { name: /Offline mode/ }).waitFor();
  await t.pause(1800);
  await t.press("Escape");
  await t.pause(700);
  await t.loopBack();
  await t.shot.end("palette-search");
}
