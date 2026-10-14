// `cmd magic <request>` in a cmd terminal (docs/56, "Magic on V3"): the app makes the widget.
// A Magic window opens in this terminal's workspace and builds the request into a package;
// its steps print here as they happen, the grants sheet asks in the app when the package wants
// something, and the window becomes the widget. Prints the package's folder (a terminal
// command, for a build that ends with one); exits 1 when the build fails, saying why.

import type { AppWindow, CoreEvent, MagicState, MagicStep, RpcClient } from "@cmd/protocol";
import { bold, dim, green, red, yellow } from "./magic.ts";

export async function magicInApp(client: RpcClient, prompt: string, o: { json: boolean }): Promise<number> {
  const w = await client.call("window.open", { kind: "magic", input: {}, callerPaneId: process.env.CMD_PANE_ID });
  if (!o.json) process.stderr.write(`${bold("✦")} ${prompt} ${dim("· made in cmd's window beside you")}\n`);
  const shown = new Set<number>();
  let asked = false;
  const step = (s: MagicStep) => {
    if (o.json) return console.log(JSON.stringify({ type: "step", step: s }));
    if (s.ms === undefined) {
      if (s.tool === "permissions" && !asked) process.stderr.write(`  ${yellow("?")} ${s.why} ${dim("· allow it in cmd")}\n`);
      asked ||= s.tool === "permissions";
      return;
    }
    if (shown.has(s.id)) return;
    shown.add(s.id);
    process.stderr.write(`  ${s.isError ? red("✗") : green("✓")} ${s.why.padEnd(34).slice(0, 34)} ${dim(s.detail.slice(0, 60))}${s.isError && s.output ? "\n     " + red(s.output.split("\n")[0]!.slice(0, 110)) : ""}\n`);
  };
  const done = new Promise<number>((resolve) => {
    const finish = async (win: AppWindow) => {
      if (win.kind.startsWith("pkg:")) {
        const entry = (await client.call("widget.list", {})).find((e) => e.ref === win.kind);
        if (o.json) console.log(JSON.stringify({ type: "result", ok: true, kind: win.kind, dir: entry?.dir ?? null }));
        else {
          process.stderr.write(`  ${green("✓")} ${win.title} ${dim(`· ${win.kind}`)}\n`);
          console.log(entry?.dir ?? win.kind);
        }
        return resolve(0);
      }
      const s = win.state as MagicState;
      if (s.phase === "ready" && s.kind === "terminal" && s.command) {
        if (o.json) console.log(JSON.stringify({ type: "result", ok: true, command: s.command }));
        else console.log(s.command);
        return resolve(0);
      }
      if (s.phase === "error") {
        if (o.json) console.log(JSON.stringify({ type: "result", ok: false, error: s.error ?? null }));
        else process.stderr.write(`  ${red("✗")} ${s.error ?? "The widget couldn't be made."}\n`);
        resolve(1);
      }
    };
    client.onEvent((e: CoreEvent) => {
      if (e.type === "magic.stream" && e.id === w.id && e.progress.type === "step") step(e.progress.step);
      else if (e.type === "window.updated" && e.window.id === w.id) void finish(e.window);
      else if (e.type === "window.removed" && e.id === w.id) {
        if (!o.json) process.stderr.write(`  ${red("✗")} the window was closed\n`);
        resolve(1);
      }
    });
  });
  await client.call("events.subscribe", { types: ["magic.stream", "window.updated", "window.removed"] });
  await client.call("magic.run", { id: w.id, prompt });
  const stop = () => void client.call("magic.cancel", { id: w.id }).catch(() => {});
  process.once("SIGINT", stop);
  return done;
}
