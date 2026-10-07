// A showcase of driving cmd: a keyboard shortcut, typing in the editor, a
// tooltip on hover, a window dragged by its title, a file dragged into the
// terminal, trackpad scrolling through scrollback, and the sidebar's search.
// Each part is one kind of interaction, found by role and name.

import type { Tour } from "../src/driver.ts";
import type { TourMeta } from "../src/run.ts";
import { TYPING } from "../src/typing.ts";

export const meta: TourMeta = {
  files: {
    "website/README.md": "# Website\n\nThe marketing site.\n\n- npm run dev: serve it\n- npm run build: ship it\n",
    "website/index.html": "<!doctype html>\n<title>Website</title>\n",
    "website/styles.css": "body { font: 16px system-ui; }\n",
    "website/src/app.ts": "export const app = () => {};\n",
  },
  // Unrecorded: a terminal in the project and a Files window, side by side.
  setup: async (t) => {
    const p = t.page;
    await t.command("file.newTerminal");
    await p.getByRole("main").getByRole("textbox", { name: "Terminal input" }).waitFor();
    await t.pause(500);
    await t.type("cd website && clear\n");
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

  // 1. The keyboard: ⌘K, then a text window from the palette.
  await t.pause(600);
  await t.press("k", "cmd");
  await p.getByRole("combobox").waitFor();
  await t.type("new text", TYPING.field);
  await p.getByRole("option", { name: "New Text Window", selected: true }).waitFor();
  await t.press("Return");
  const editor = main.getByRole("textbox", { name: "Text editor" });
  await editor.waitFor();
  await t.pause(400);
  await t.type("# Release notes\n\n- Tours drive cmd like a person would\n", TYPING.field);
  await t.pause(800);

  // 2. Hover: the Strip button's tooltip.
  await t.hover(p.getByRole("button", { name: "Strip" }), 1400);
  await t.away();

  // 3. Drag a window by its title: the text window onto the terminal's place.
  const text = main.getByRole("group", { name: /^Untitled/ });
  await t.drag(text.getByText(/^Untitled/).first(), terminal);
  await t.pause(1000);

  // 4. Drag a file into the terminal: its path lands at the prompt.
  await t.click(terminal);
  await t.type("cat ");
  await t.drag(files.getByRole("treeitem", { name: "README.md", exact: true }), terminal);
  await t.pause(500);
  await t.press("Return");
  await t.pause(1200);

  // 5. Scroll: a long output, then back up through it with the trackpad.
  await t.type("seq 1 300\n");
  await t.pause(800);
  await t.scroll(terminal, { by: -900 });
  await t.pause(1200);

  // 6. Search the sidebar, then go to the match: the Files window.
  await t.click(p.getByRole("textbox", { name: "Search sessions" }));
  await t.type("website", TYPING.field);
  const hit = p.getByRole("tree", { name: "Open" }).getByRole("treeitem", { name: /^website, files/ });
  await hit.waitFor();
  await t.pause(500);
  await t.click(hit);
  await t.away();
  await t.pause(1500);
}
