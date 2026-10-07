// Kai's strip: every window side by side in one sideways strip, swiped through
// with the trackpad. The page dots say which window is which, an edge drag
// makes one wider, the sidebar and ⇧⌘] jump along it, and clicking into a
// window that's off to the side swipes there first, like a person would.

import type { Tour } from "../src/driver.ts";
import type { TourMeta } from "../src/run.ts";
import { TYPING } from "../src/typing.ts";

const call = (t: Tour, method: string, params: unknown) =>
  t.page.evaluate(([m, p]) => (window as unknown as { cmd: { call: (m: string, p: unknown) => Promise<unknown> } }).cmd.call(m as string, p), [method, params] as const);

export const meta: TourMeta = {
  ai: true,
  // Unrecorded: a working morning's windows, in the strip.
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
    // Claude Code, asked something earlier.
    await t.command("file.newClaude");
    const claude = main.getByRole("group", { name: /claude/i }).last();
    await t.waitForText(claude, /\? for shortcuts|auto mode/i, 30_000);
    await t.pause(500);
    await t.type("where does atlas render a trip? one sentence\n", TYPING.exact);
    await t.waitForText(claude, /(Worked|Cooked|Brewed|Baked|Churned|Crunched|Sautéed|Cogitated|done) .*\d/i, 90_000).catch(() => {});
    const home = await p.evaluate(() => (window as unknown as { cmd: { homeDir: string } }).cmd.homeDir);
    await call(t, "window.openTarget", { target: `${home}/src/atlas/README.md` });
    await main.getByRole("group", { name: /^README\.md/ }).waitFor();
    // Back to the start of the strip.
    await t.command("session.next");
    await t.pause(1200);
  },
};

export default async function (t: Tour) {
  const p = t.page;
  const main = p.getByRole("main");
  const dots = p.getByRole("group", { name: "Windows" });
  await t.pause(1000);

  // 1. Swipe along the strip, and back.
  const w = await t.windowBox();
  await t.moveTo({ x: w.x + w.width * 0.55, y: w.y + w.height * 0.5 });
  await t.swipe(900);
  await t.pause(900);
  await t.swipe(900);
  await t.pause(1100);
  await t.swipe(-1500);
  await t.pause(900);

  // 2. The page dots: one per window, by name. Jump to Claude.
  await t.hover(dots.getByRole("button", { name: /claude/i }), 900);
  await t.click(dots.getByRole("button", { name: /claude/i }));
  await t.pause(1400);

  // 3. Wider: drag the terminal's right edge.
  const shell = main.getByRole("group", { name: /^zsh/ });
  await t.reveal(shell);
  await t.dragBy(shell.getByRole("separator", { name: "Right edge" }), 260);
  await t.pause(1000);

  // 4. The sidebar jumps along the strip too.
  await t.click(p.getByRole("tree", { name: "Windows" }).getByRole("treeitem", { name: /^README\.md/ }));
  await t.pause(1400);

  // 5. And the keyboard: ⇧⌘] to the next one.
  await t.press("]", "cmd", "shift");
  await t.pause(1200);

  // 6. Back in the terminal (off to the side: swiped to, then clicked).
  await t.click(shell);
  await t.type("git status --short\n");
  await t.pause(1500);
}
