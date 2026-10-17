// `cmd quick …` (docs/58): the person's Quick Commands, listed, run, added and removed from
// the terminal. A run takes this folder (and this terminal's workspace) as what it looks at;
// --var fills in a {{variable}} or answers an {{ask:…}}.

import { parseQuick, QUICK_VARIABLES, type QuickCommand, type QuickContext } from "@cmd/protocol";
import type { Connection } from "@cmd/protocol/node";

type Client = Connection["client"];

export const QUICK_HELP = `  quick [--json]                      your Quick Commands (Settings → Quick Commands)
  quick run NAME [--var K=V…] [--yes] [--json]
                                      run one here; --var fills a {{variable}} or answers an {{ask:…}},
                                      --yes runs one that asks first; "type" ones run in a new terminal
  quick add NAME BODY [--target type|terminal|open] [--key SHORTCUT]   add one
  quick rm NAME                       remove one`;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

/** One line per command: its name, where it goes, its body. */
function row(c: QuickCommand, w: number): string {
  const where = { type: "type", terminal: "new terminal", open: "open" }[c.target ?? "type"];
  const keys = c.keys?.length ? `  [${c.keys.join(", ")}]` : "";
  return `  ${c.name.padEnd(w)}  ${where.padEnd(12)}  ${c.body.replace(/\s+/g, " ")}${keys}${c.confirm ? "  (asks first)" : ""}`;
}

export async function quickCommand(client: Client, pos: string[], opt: Record<string, unknown>, callerPaneId: string | undefined): Promise<number> {
  const [sub = "ls", ...args] = pos;
  if (sub === "ls" || sub === "list") {
    const l = await client.call("quick.list", {});
    if (opt.json) return console.log(JSON.stringify(l, null, 2)), 0;
    if (l.error) console.error(`${l.path} can't be read: ${l.error} (the last good commands are shown)`);
    for (const p of l.problems ?? []) console.error(`${l.path}: ${p}`);
    if (!l.commands.length) return console.log(`No Quick Commands yet. Add one in Settings → Quick Commands, or: cmd quick add NAME BODY`), 0;
    const w = Math.min(28, Math.max(...l.commands.map((c) => c.name.length)));
    for (const c of l.commands) console.log(row(c, w));
    return 0;
  }
  if (sub === "run") {
    const name = args.join(" ");
    if (!name) throw new Error("usage: cmd quick run NAME [--var K=V…]");
    const context: QuickContext = { folder: process.cwd() };
    const values: Record<string, string> = {};
    for (const kv of list(opt.var)) {
      const at = kv.indexOf("=");
      if (at < 1) throw new Error(`--var takes NAME=VALUE: not "${kv}"`);
      const [k, v] = [kv.slice(0, at), kv.slice(at + 1)];
      if (k === "file" || k === "selection" || k === "url" || k === "folder") context[k] = v;
      else values[k] = v;
    }
    const r = await client.call("quick.run", { id: name, context, values, confirmed: !!opt.yes, callerPaneId });
    if (opt.json) return console.log(JSON.stringify(r, null, 2)), 0;
    console.log(r.paneId ? `${r.text}  (pane ${r.paneId})` : r.text);
    return 0;
  }
  if (sub === "add") {
    const [name, ...body] = args;
    if (!name || !body.length) throw new Error("usage: cmd quick add NAME BODY [--target type|terminal|open] [--key SHORTCUT]");
    const text = body.join(" ");
    const bad = parseQuick(text).errors;
    if (bad.length) throw new Error(`${bad.join("; ")} (variables: ${Object.keys(QUICK_VARIABLES).join(", ")}, ask:NAME, pick:NAME=a,b)`);
    const target = str(opt.target) as QuickCommand["target"];
    const keys = list(opt.key);
    const c = await client.call("quick.save", { command: { name, body: text, ...(target ? { target } : {}), ...(keys.length ? { keys } : {}) } });
    return console.log(opt.json ? JSON.stringify(c, null, 2) : `Added "${c.name}" (${c.id})`), 0;
  }
  if (sub === "rm" || sub === "remove") {
    const name = args.join(" ");
    const l = await client.call("quick.list", {});
    const c = l.commands.find((x) => x.id === name) ?? l.commands.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!c) throw new Error(`no Quick Command "${name}" (cmd quick lists them)`);
    await client.call("quick.remove", { id: c.id });
    return console.log(`Removed "${c.name}"`), 0;
  }
  throw new Error(`cmd quick ${sub}: not a subcommand (ls, run, add, rm)`);
}
