// `cmd widget link|unlink|remove` (docs/56, "Developer ergonomics"): a widget package folder
// anywhere, linked into the packages folder (~/.cmd/widgets, or $CMD_WIDGETS_HOME) under its
// name, so the Widget Library lists it and saves in it reload its windows; and taken out again.
// With a cmd running, link waits until the Library lists the package, asks the person for
// what it wants (the grants sheet, when it wants anything) and prints its entry; unlink waits
// until it's gone. A folder that isn't a link is the person's: removed only with --force.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { CoreEvent, WidgetEntry } from "@cmd/protocol";
import { connect, widgetsHome, type Connection } from "@cmd/protocol/node";
import { cmdVersion, readPackage } from "@cmd/core/widgets/package";
import { dim, green, red } from "./magic.ts";

export const LINK_SUBS = ["link", "unlink", "remove"];

export const WIDGET_LINK_HELP = `       cmd widget link [dir]        add a widget package to the Widget Library from its folder (a link in
                                   ~/.cmd/widgets); cmd asks for what it wants, and saves reload it
       cmd widget unlink <name>     take a linked package out of the Widget Library (also: remove;
                                   --force removes a package that isn't a link, folder and all)`;

/** How long to wait for the Library to list (or drop) a package. */
const LIBRARY_MS = 5000;

const tilde = (p: string) => {
  const home = process.env.HOME;
  return home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p;
};

/** The Library's line for a package's widget, as `cmd widget list` prints it. */
const line = (e: WidgetEntry) => `${e.ref.padEnd(32)} ${e.title}${dim(`  ${e.name} ${e.version} · API ${e.api}${e.link ? ` · from ${tilde(e.link)}` : ""}`)}`;

export async function widgetLinkCommand(argv: string[]): Promise<number> {
  const { values: o, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { force: { type: "boolean" }, json: { type: "boolean" } } });
  const [sub, arg] = positionals;
  const home = widgetsHome();
  if (sub === "link") return link(home, path.resolve(arg ?? "."), !!o.json);
  if (!arg) {
    console.error(red(`usage: cmd widget ${sub} <name>`));
    return 1;
  }
  return unlink(home, arg, !!o.force);
}

async function link(home: string, given: string, json: boolean): Promise<number> {
  let dir: string;
  try {
    dir = fs.realpathSync(given);
  } catch {
    console.error(red(`${tilde(given)} doesn't exist`));
    return 1;
  }
  const r = readPackage(dir, { cmdVersion: cmdVersion() });
  if (!r.ok) {
    console.error(`${red("✗")} ${path.basename(dir)} ${dim(`· can't be linked: ${r.errors.length} ${r.errors.length === 1 ? "problem" : "problems"} in package.json`)}`);
    for (const e of r.errors) console.error(red(`  ${e}`));
    return 2;
  }
  const name = r.pkg.name;
  const at = path.join(home, name);
  let there: fs.Stats | null = null;
  try {
    there = fs.lstatSync(at);
  } catch {}
  if (there) {
    const same = there.isSymbolicLink() && realOrNull(at) === dir;
    if (!same) {
      const what = there.isSymbolicLink() ? `a link to ${tilde(fs.readlinkSync(at))}` : "a package of its own";
      console.error(red(`${tilde(at)} is ${what}. Unlink it first: cmd widget unlink ${name}`));
      return 1;
    }
  } else {
    fs.mkdirSync(home, { recursive: true });
    fs.symlinkSync(dir, at);
  }

  const conn = await connect().catch(() => null);
  if (!conn) {
    console.log(`${green("✓")} ${name} ${r.pkg.version} linked ${dim(`· ${tilde(at)} → ${tilde(dir)}`)}`);
    process.stderr.write(dim("  cmd isn't running: the Widget Library lists it when cmd starts\n"));
    return 0;
  }
  try {
    const entries = await library(conn, (list) => list.some((e) => e.name === name && e.source === "package"));
    const mine = entries?.filter((e) => e.name === name && e.source === "package") ?? [];
    if (!mine.length) {
      console.error(red(`linked ${tilde(at)}, but the Widget Library didn't list it within ${LIBRARY_MS / 1000} s`));
      return 2;
    }
    if (mine[0]!.problem) {
      console.error(red(`linked, but cmd can't use it: ${mine[0]!.problem}`));
      return 2;
    }
    // Ask now, not at the first window: the person just chose to add it.
    await conn.client.call("widget.ask", { name });
    const asked = (await conn.client.call("widget.list", {})).filter((e) => e.name === name && e.source === "package");
    if (json) console.log(JSON.stringify(asked, null, 2));
    else {
      for (const e of asked) console.log(line(e));
      if (asked[0]?.ask) process.stderr.write(dim("  cmd asks for what it wants in the app; add it with cmd widget add " + asked[0].ref + "\n"));
      else process.stderr.write(dim(`  add it with cmd widget add ${asked[0]?.ref}; saves in ${tilde(dir)} reload it\n`));
    }
    return 0;
  } finally {
    conn.close();
  }
}

async function unlink(home: string, name: string, force: boolean): Promise<number> {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || name.includes("..")) {
    console.error(red(`${name} isn't a widget package's name`));
    return 1;
  }
  const at = path.join(home, name);
  let there: fs.Stats;
  try {
    there = fs.lstatSync(at);
  } catch {
    console.error(red(`no widget package ${name} in ${tilde(home)}`));
    return 1;
  }
  if (there.isSymbolicLink()) fs.unlinkSync(at);
  else if (!force) {
    console.error(red(`${name} isn't linked: it's a folder in ${tilde(home)}. Remove it in Finder, or with --force.`));
    return 1;
  } else fs.rmSync(at, { recursive: true, force: true });

  const conn = await connect().catch(() => null);
  if (conn)
    try {
      const gone = await library(conn, (list) => !list.some((e) => e.name === name && e.source === "package"));
      if (!gone) process.stderr.write(dim(`  the Widget Library still lists ${name}; it goes once cmd reads the folder again\n`));
    } finally {
      conn.close();
    }
  console.log(`${green("✓")} ${name} ${there.isSymbolicLink() ? "unlinked" : "removed"}`);
  return 0;
}

/** The Library once `ok` holds for it (now, or at a widget.library event), or null after LIBRARY_MS. */
async function library(conn: Connection, ok: (list: WidgetEntry[]) => boolean): Promise<WidgetEntry[] | null> {
  let done: (v: WidgetEntry[] | null) => void = () => {};
  const result = new Promise<WidgetEntry[] | null>((r) => (done = r));
  const timer = setTimeout(() => done(null), LIBRARY_MS);
  conn.client.onEvent((e: CoreEvent) => {
    if (e.type === "widget.library" && ok(e.entries)) done(e.entries);
  });
  await conn.client.call("events.subscribe", { types: ["widget.library"] });
  const now = await conn.client.call("widget.list", {});
  if (ok(now)) done(now);
  const v = await result;
  clearTimeout(timer);
  return v;
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}
