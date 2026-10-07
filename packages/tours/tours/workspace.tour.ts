// A workspace tour: a terminal in a project, a Files window next to it in the
// grid, a README opened from its native context menu, then the palette to
// switch to the canvas.

import type { Tour } from "../src/driver.ts";
import type { TourMeta } from "../src/run.ts";
import { TYPING } from "../src/typing.ts";

export const meta: TourMeta = {
  files: {
    "website/README.md": "# Website\n\nThe marketing site. `npm run dev` serves it on port 5173.\n\n## Layout\n\n- `src/` the pages\n- `styles.css` one stylesheet\n",
    "website/index.html": "<!doctype html>\n<title>Website</title>\n",
    "website/styles.css": "body { font: 16px system-ui; }\n",
    "website/package.json": '{ "name": "website", "scripts": { "dev": "vite" } }\n',
    "website/src/app.ts": "export const app = () => {};\n",
    "website/src/router.ts": "export const routes = [];\n",
  },
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
  await t.type("cd website && ls\n");
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

  // The palette, to the canvas.
  await t.click(p.getByRole("button", { name: "Command Palette" }));
  await t.type("canvas", TYPING.field);
  await p.getByRole("option", { name: "Canvas", exact: true, selected: true }).waitFor();
  await t.pause(300);
  await t.press("Return");
  await t.away();
  await t.pause(1800);
}
