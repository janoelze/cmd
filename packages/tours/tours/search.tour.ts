// A website loop (1:1) of the sidebar's session search: typing finds open
// windows and past agent sessions, with the matching passage; Escape clears it.

import type { Tour } from "../src/driver.ts";
import type { TourMeta } from "../src/run.ts";
import { TYPING } from "../src/typing.ts";

export const meta: TourMeta = {
  // Unrecorded: a terminal in atlas and Files, so the sidebar has windows too.
  setup: async (t) => {
    const p = t.page;
    await t.command("file.newTerminal");
    await p.getByRole("main").getByRole("textbox", { name: "Terminal input" }).waitFor();
    await t.pause(400);
    await t.type("cd ~/src/atlas && clear\n", TYPING.exact);
    await t.command("file.newFiles");
    await p.getByRole("tree", { name: "Files" }).getByRole("treeitem", { name: "README.md", exact: true }).waitFor();
    await t.away();
  },
};

export default async function (t: Tour) {
  const p = t.page;
  const field = p.getByRole("textbox", { name: "Search sessions" });
  const history = p.getByRole("tree", { name: "History" });
  // Framed on the field and its results (the box held longest), not the whole tall sidebar.
  await t.shot.start("search", { region: [field, history], pad: 48 });
  await t.pause(600);
  await t.click(field);
  await t.type("offline", TYPING.exact, { stay: true });
  const hit = history.getByRole("treeitem", { name: /Offline mode/ });
  await hit.waitFor();
  await t.pause(600);
  await t.hover(hit);
  await t.pause(1600);
  await t.press("Escape");
  await t.press("Escape");
  await t.pause(500);
  await t.loopBack();
  await t.shot.end("search");
}
