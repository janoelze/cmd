// `cmd widget dev [dir]` (docs/56, "Developer ergonomics"): the widget package in this folder,
// live on the board while you edit it, as Raycast's `ray develop`. It links the folder into the
// Widget Library (widget-link.ts), asks for what it wants (the grants sheet in the app), puts
// each of its widgets on the board (or keeps the window it already has), and prints what the
// widget's process says: its status, its console (`widget.log`), errors with their stack, and
// each tree and patch. Saves reload it (the core's hot reload); a package.json that renames a
// config field writes cmd-env.d.ts again. Ctrl-C stops printing: the link and the windows stay
// (`cmd widget remove <name>` takes it out).

import fs from "node:fs";
import path from "node:path";
import { ENV, type CoreEvent, type TreeNode, type WidgetEntry } from "@cmd/protocol";
import { connect, defaultSocketPath, widgetsHome } from "@cmd/protocol/node";
import { writeEnvTypes } from "@cmd/core/magic";
import { cmdVersion, readPackage } from "@cmd/core/widgets/package";
import { dim, green, red, yellow } from "./magic.ts";
import { ensureLink, library, tilde } from "./widget-link.ts";
import { prepare } from "./widget-new.ts";

const count = (nodes: TreeNode[]): number => nodes.reduce((n, x) => n + 1 + (x.type === "#text" ? 0 : count(x.children)), 0);
const time = () => dim(new Date().toTimeString().slice(0, 8));

/** One event as a line of dev's output, or null for one it doesn't print. `title`: the window's widget. */
export function devLine(e: CoreEvent, title: string, dir = ""): string | null {
  if (e.type === "widget.log") {
    // The stack's own frames, paths relative to the package; none from inside cmd's runtime.
    const stack = (e.stack ?? "")
      .split("\n")
      .map((l) => l.trim().replaceAll(`file://${dir}/`, "").replaceAll(`${dir}/`, ""))
      .filter((l) => l && l !== `Error: ${e.message}` && !/\/(widget-api|runtime)\/|dist\/deno|node_modules/.test(l));
    const text = stack.length ? `${e.message}\n${[...new Set(stack)].map((l) => "    " + l).join("\n")}` : e.message;
    const tag = e.level === "info" || e.level === "debug" ? title : `${title} ${e.level}`;
    return e.level === "error" ? red(`${tag}  ${text}`) : e.level === "warn" ? yellow(`${tag}  ${text}`) : `${dim(tag)}  ${text}`;
  }
  if (e.type !== "widget.tree") return null;
  const m = e.message;
  if (m.kind === "tree") return dim(`${title} drew ${count(m.nodes)} elements`);
  if (m.kind === "patch") return dim(`${title} patch ${m.rev}: ${[...new Set(m.ops.map((o) => o.op))].join(", ")}`);
  const what =
    m.state === "waiting-grant" ? "waits for you to allow what it asks, in cmd"
    : m.state === "stopped" ? `stopped${m.reason ? ` · ${m.reason}` : ""}${m.detail ? `\n    ${m.detail}` : ""}`
    : m.state;
  return m.state === "stopped" ? red(`${title} ${what}`) : `${title} ${what}`;
}

export async function devCommand(argv: string[]): Promise<number> {
  const dir = path.resolve(argv.find((a) => !a.startsWith("-")) ?? ".");
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    console.error(red(`${tilde(dir)} doesn't exist`));
    return 1;
  }
  const r = readPackage(real, { cmdVersion: cmdVersion() });
  if (!r.ok) {
    console.error(`${red("✗")} ${path.basename(real)} ${dim(`· ${r.errors.length} ${r.errors.length === 1 ? "problem" : "problems"} in package.json`)}`);
    for (const e of r.errors) console.error(red(`  ${e}`));
    return 2;
  }
  const name = r.pkg.name;
  prepare(real);

  const conn = await connect().catch(() => null);
  if (!conn) {
    console.error(red(`cmd isn't running (no core at ${defaultSocketPath()}). Open cmd, then run cmd widget dev again.`));
    return 2;
  }
  const refused = ensureLink(widgetsHome(), real, name);
  if (refused) {
    conn.close();
    console.error(red(refused));
    return 1;
  }
  const client = conn.client;
  const mine = (list: WidgetEntry[]) => list.filter((e) => e.source === "package" && e.name === name);
  const listed = await library(conn, (list) => mine(list).length > 0);
  const entries = mine(listed ?? []);
  if (!entries.length) {
    conn.close();
    console.error(red(`linked, but the Widget Library didn't list ${name}. Is it the cmd you expect? (CMD_HOME, CMD_WIDGETS_HOME)`));
    return 2;
  }
  if (entries[0]!.problem) {
    conn.close();
    console.error(red(`cmd can't run ${name}: ${entries[0]!.problem}`));
    return 2;
  }

  // Follow its windows: print what they say, from now on.
  const titles = new Map<string, string>();
  client.onEvent((e) => {
    if ((e.type === "widget.tree" || e.type === "widget.log") && titles.has(e.windowId)) {
      const line = devLine(e, titles.get(e.windowId)!, real);
      if (line) console.log(`${time()} ${line}`);
    }
    if (e.type === "window.removed" && titles.has(e.id)) {
      console.log(`${time()} ${titles.get(e.id)} ${dim("closed; cmd widget dev puts it back")}`);
      titles.delete(e.id);
    }
  });
  await client.call("events.subscribe", { types: ["widget.tree", "widget.log", "window.removed"] });
  await client.call("widget.ask", { name });

  for (const e of entries) {
    let id = e.windows[0];
    if (!id) id = (await client.call("widget.add", { ref: e.ref, callerPaneId: process.env[ENV.paneId] || undefined })).id;
    titles.set(id, e.title);
    // The window's status and whole tree now, then each change.
    await client.call("widget.resync", { windowId: id }).catch(() => {});
  }
  console.log(`${green("✓")} ${name} ${r.pkg.version} on the board ${dim(`· ${entries.map((e) => e.ref).join(", ")} · from ${tilde(real)}`)}`);
  console.log(dim("  saves reload it; Ctrl-C stops printing, the widget stays (cmd widget remove " + name + " takes it out)"));

  // package.json changed: its config's types follow.
  let timer: NodeJS.Timeout | undefined;
  const watcher = fs.watch(path.join(real, "package.json"), () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const again = readPackage(real);
      if (again.ok && writeEnvTypes(real, again.pkg)) console.log(`${time()} ${dim("package.json changed: cmd-env.d.ts written again")}`);
    }, 250);
  });

  return new Promise<number>((resolve) => {
    let stopping = false;
    const stop = () => {
      stopping = true;
      watcher.close();
      conn.close();
      resolve(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    void conn.closed.then(() => {
      if (stopping) return;
      console.error(red("cmd went away; run cmd widget dev again once it's back"));
      watcher.close();
      resolve(1);
    });
  });
}
