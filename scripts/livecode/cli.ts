// pnpm livecode: everything Jam's AI knows, and how well it does, in one place.
//
//   pnpm livecode build [reference|atlas]   regenerate the knowledge in packages/core/src/livecode:
//                                           reference.md (Strudel's functions, from @strudel/reference)
//                                           and atlas.json + atlas.md (every sample, measured)
//   pnpm livecode check [--audio]           the hand-written examples (cookbook.md, sound-design.md)
//                                           evaluate and use sounds that load (--audio: and are heard)
//   pnpm livecode eval <command>            the evals: pnpm livecode eval help
//
// When to run what: `build` after bumping @strudel/web or changing the sample maps
// (apps/desktop/src/livecode/sample-maps.json); `check` after editing the cookbook
// or the sound-design guide; `eval run` before and after changing the prompt.
// Everything runs Strudel in headless Chromium (Playwright's), no app needed.

import { buildAtlas } from "./atlas.ts";
import { check } from "./check.ts";
import { evalCommand } from "./eval.ts";
import { buildReference } from "./reference.ts";

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "build") {
  const what = rest[0];
  if (!what || what === "reference") await buildReference();
  if (!what || what === "atlas") await buildAtlas();
} else if (cmd === "check") {
  process.exitCode = (await check({ audio: rest.includes("--audio") })) ? 0 : 1;
} else if (cmd === "eval") {
  await evalCommand(rest);
} else {
  console.log("usage: pnpm livecode build [reference|atlas] | check [--audio] | eval <refs|run|report|rescore|rate|listen|show|sound> …");
  process.exitCode = cmd ? 1 : 0;
}
