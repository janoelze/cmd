// The Mac's clipboard for the widget API's clipboard.write (API 1.2): text only, through
// /usr/bin/pbcopy, so it works while the app isn't in front (the press that asked came from
// it). Never for a press from a paired device (the adapter refuses it first: widget-verbs.ts's
// `local`), one write per press, clipped to reads.ts's CLIPBOARD_MAX.

import { spawn } from "node:child_process";

const PBCOPY = "/usr/bin/pbcopy";

/** Puts `text` on the clipboard; rejects when pbcopy can't. */
export function writeClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform !== "darwin") return reject(new Error("this cmd has no clipboard to write to"));
    const child = spawn(PBCOPY, [], { stdio: ["pipe", "ignore", "ignore"], env: { ...process.env, LANG: process.env.LANG || "en_US.UTF-8" } });
    const timer = setTimeout(() => child.kill(), 5000);
    child.on("error", (e) => (clearTimeout(timer), reject(e)));
    child.on("exit", (code) => (clearTimeout(timer), code === 0 ? resolve() : reject(new Error(`pbcopy ended with ${code}`))));
    child.stdin.end(text, "utf8");
  });
}
