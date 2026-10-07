// Probe: does real Claude Code start cleanly in Kai's fixture (no first-run
// screens), and does cmd's sidebar follow it? One cheap read-only question.

import type { Tour } from "../src/driver.ts";
import type { TourMeta } from "../src/run.ts";
import { TYPING } from "../src/typing.ts";

export const meta: TourMeta = {
  ai: true,
  setup: async (t) => {
    await t.command("file.newTerminal");
    await t.page.getByRole("main").getByRole("textbox", { name: "Terminal input" }).waitFor();
    await t.pause(500);
    await t.type("cd ~/src/atlas && clear\n", TYPING.exact);
    await t.pause(400);
  },
};

export default async function (t: Tour) {
  const p = t.page;
  await t.pause(500);
  await t.type("claude\n", TYPING.exact);
  await t.pause(6000);
  await t.type("what does src/trip.ts do? one sentence", TYPING.field);
  await t.pause(400);
  await t.press("Return");
  await p.getByRole("tree", { name: "Agents" }).waitFor({ timeout: 20_000 }).catch(() => console.log("no Agents section"));
  await t.pause(15000);
}
