// Checks the hand-written knowledge Live Code's AI gets (pnpm livecode check): every
// code block in the cookbook and the sound-design guide must evaluate in Strudel,
// produce events, and use only sounds the sample maps load. With --audio each block
// is also played, and a sound that makes no sound fails it. Exits 1 on a failure.

import fs from "node:fs";
import path from "node:path";
import { openStrudel, root } from "./browser.ts";

/** The files whose code blocks are examples the AI copies. */
const FILES = ["cookbook.md", "sound-design.md"].map((f) => path.join(root, "packages/core/src/livecode", f));

export async function check({ audio = false } = {}): Promise<boolean> {
  const strudel = await openStrudel();
  let failed = 0, total = 0;
  for (const file of FILES) {
    const text = fs.readFileSync(file, "utf8");
    console.log(path.basename(file));
    // Each block is named by the line before it (its heading or description).
    for (const m of text.matchAll(/([^\n]*)\n```\n([\s\S]*?)```/g)) {
      total++;
      const name = (m[1] || "block").replace(/^#+\s*/, "").slice(0, 60);
      const r = await strudel.run(m[2]!, 4);
      const problems = [r.error, !r.error && !r.events.length && "no events", r.unknown.length && `unknown sounds: ${r.unknown.join(", ")}`].filter(Boolean) as string[];
      if (audio && !problems.length) {
        const heard = await strudel.audio(m[2]!, 1.5);
        if (heard.silent.length) problems.push(`silent: ${heard.silent.join(", ")}`);
      }
      if (problems.length) failed++;
      console.log(`  ${problems.length ? "✗" : "✓"} ${name}${problems.length ? `: ${problems.join(" · ")}` : ""}`);
    }
  }
  await strudel.close();
  console.log(failed ? `${failed} of ${total} examples fail` : `all ${total} examples play`);
  return failed === 0;
}
