// Kai's morning, as a showcase of driving cmd: a keyboard shortcut, typing in
// the editor, a tooltip on hover, a window dragged by its title, a file
// dragged into the terminal, trackpad scrolling through output, and the
// sidebar's search. Each part is one kind of interaction, found by role and
// name. (The fizzbuzz is for Thursday's interview.)

import type { Tour } from "../src/driver.ts";
import type { TourMeta } from "../src/run.ts";
import { TYPING } from "../src/typing.ts";

export const meta: TourMeta = {
  // Unrecorded: a terminal in atlas and a Files window there, side by side.
  setup: async (t) => {
    const p = t.page;
    await t.command("file.newTerminal");
    await p.getByRole("main").getByRole("textbox", { name: "Terminal input" }).waitFor();
    await t.pause(500);
    await t.type("cd ~/src/atlas && clear\n");
    await t.pause(400);
    await t.command("file.newFiles");
    await p.getByRole("tree", { name: "Files" }).getByRole("treeitem", { name: "README.md", exact: true }).waitFor();
    await t.command("view.grid");
    await t.pause(600);
  },
};

export default async function (t: Tour) {
  const p = t.page;
  const main = p.getByRole("main");
  const terminal = main.getByRole("group", { name: /^zsh/ });
  const files = p.getByRole("tree", { name: "Files" });

  // 1. The keyboard: ⌘K, then a note from the palette.
  await t.pause(600);
  await t.press("k", "cmd");
  await p.getByRole("combobox").waitFor();
  await t.type("new text", TYPING.field);
  await p.getByRole("option", { name: "New Text Editor", selected: true }).waitFor();
  await t.press("Return");
  await main.getByRole("textbox", { name: "Text editor" }).waitFor();
  await t.pause(400);
  await t.type("# Today\n\n- Date picker on mobile\n- Review Leo's PR\n", TYPING.field);
  await t.pause(800);

  // 2. Hover: the Strip button's tooltip.
  await t.hover(p.getByRole("button", { name: "Strip" }), 1400);
  await t.away();

  // 3. Drag a window by its title: the note onto the terminal's place.
  const note = main.getByRole("group", { name: /^Untitled/ });
  await t.drag(note.getByText(/^Untitled/).first(), terminal);
  await t.pause(1000);

  // 4. Drag a file into the terminal: its path lands at the prompt.
  await t.click(terminal);
  await t.type("cat ");
  await t.drag(files.getByRole("treeitem", { name: "README.md", exact: true }), terminal);
  await t.pause(500);
  await t.press("Return");
  await t.pause(1200);
  await t.type("git log --oneline\n");
  await t.pause(1400);

  // 5. Scroll: Thursday's fizzbuzz, then back up through it with the trackpad.
  await t.type("node ../fizzbuzz/fizzbuzz.ts\n");
  await t.pause(900);
  await t.scroll(terminal, { by: -700 });
  await t.pause(1200);

  // 6. Search the sidebar, then go to the match: the Files window.
  await t.click(p.getByRole("textbox", { name: "Search sessions" }));
  await t.type("atlas", TYPING.field);
  const hit = p.getByRole("tree", { name: "Open" }).getByRole("treeitem", { name: /^atlas, files/ });
  await hit.waitFor();
  await t.pause(500);
  await t.click(hit);
  await t.away();
  await t.pause(1500);
}
