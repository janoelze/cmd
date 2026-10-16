// `pnpm phone:use [worktree | CMD_HOME | phone]`: points /c/dev at another dev
// core for a while (docs/56-phone-development.md), e.g. a worktree's own
// .cmd-dev, the core its `pnpm dev` app shows; "phone" (or `pnpm phone:core`)
// points it back at the phone's dev core. A core there pairs on its own: its
// host key isn't the phone core's. A running core is made reachable through the
// proxy (remote access on, Your own URL on loopback). Saved in
// ~/.cmd-phone/target.json; a running phone:serve picks it up on the next
// connection. Without an argument it says what /c/dev reaches.

import { connect } from "../../packages/protocol/src/node.ts";
import { devLine, devTarget, homeFor, phoneHome, reachable, resolveTarget, useDev } from "./targets.ts";

const given = process.argv[2];
if (given) {
  const home = homeFor(given);
  if (!home) {
    console.error("The main checkout's own dev instance can't be a target. Use pnpm phone:core there instead.");
    process.exit(1);
  }
  useDev(home === phoneHome() ? null : home);
  const conn = await connect(devTarget(home).socket).catch(() => null);
  if (conn) {
    await reachable(devTarget(home), conn).catch((e: Error) => console.error(e.message));
    conn.close();
  }
}
const t = resolveTarget("dev");
const phone = t.home === phoneHome();
console.log(`/c/dev ${given ? "now reaches" : "reaches"} ${phone ? "the phone's dev core" : t.home} (${t.home})\n  ${await devLine(t)}`);
if (given && !phone) console.log("A core here pairs on its own: pnpm phone:pair dev. pnpm phone:use phone points back.");
