// A first tour: a terminal from New…, a command in it, then a Files window and
// a file far down a folder (the driver scrolls to it).

import type { Tour } from "../src/driver.ts";
import type { TourMeta } from "../src/run.ts";
import { TYPING } from "../src/typing.ts";

const files: Record<string, string> = { "notes.md": "# Notes\n" };
for (let i = 1; i <= 40; i++) files[`src/module-${String(i).padStart(2, "0")}.ts`] = `export const n = ${i};\n`;

export const meta: TourMeta = { files };

export default async function (t: Tour) {
  const p = t.page;
  await t.click(p.getByRole("button", { name: "New…" }));
  await t.type("terminal", TYPING.field);
  await t.press("Return");
  await p.getByRole("textbox", { name: "Terminal input" }).first().waitFor();
  await t.pause(700);
  await t.type("ls src | head -4\n");
  await t.pause(1400);

  await t.click(p.getByRole("button", { name: "New…" }));
  await t.type("files", TYPING.field);
  await t.press("Return");
  const tree = p.getByRole("tree", { name: "Files" });
  await t.click(tree.getByRole("treeitem", { name: "src", exact: true }), { clicks: 2 });
  await t.click(tree.getByRole("treeitem", { name: "module-34.ts" }));
  await t.pause(1200);
}
