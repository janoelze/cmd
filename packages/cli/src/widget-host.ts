// `cmd widget grant|restart|tree|press|env`: a package widget's process from the terminal
// (docs/56). `grant` writes what a package may use (the grants sheet asks the same later);
// the rest drive one window's process the way its view does: restart it, print its tree as
// the window gets it, press one of its handlers, say where it is drawn.

import { parseArgs } from "node:util";
import { noPermissions, PERMISSION_KEYS, type CoreEvent, type TreeNode, type WidgetPermissions } from "@cmd/protocol";
import { connect, defaultSocketPath } from "@cmd/protocol/node";
import { dim, red } from "./magic.ts";

export const HOST_SUBS = ["grant", "restart", "tree", "press", "env"];

export const WIDGET_HOST_HELP = `       cmd widget grant <package> --all
                                   let a widget package use everything its package.json asks for
       cmd widget grant <package> --net api.github.com --workspace read …
                                   grant some of it (net, run, read, workspace, events, act, ai)
       cmd widget restart <window>  start a package widget's process again
       cmd widget tree <window>     print its tree, then each change (--follow)
       cmd widget press <window> <handler> [event] [value]
                                   what a click on one of its elements does (event: onClick)
       cmd widget env <window> [--theme dark|light] [--size narrow|regular|wide] [--placement board|sidebar]`;

/** A tree as indented lines: `View`, `  Text "3 agents"`, handlers as `onClick→12`. */
export function treeLines(nodes: TreeNode[], depth = 0): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    const pad = "  ".repeat(depth);
    if (n.type === "#text") {
      out.push(`${pad}${JSON.stringify(n.text)}`);
      continue;
    }
    const props = Object.entries(n.props)
      .map(([k, v]) => (v && typeof v === "object" && "$handler" in v ? `${k}→${(v as { $handler: number }).$handler}` : `${k}=${JSON.stringify(v)}`))
      .join(" ");
    out.push(`${pad}${n.type}${props ? " " + dim(props) : ""}`);
    out.push(...treeLines(n.children, depth + 1));
  }
  return out;
}

export async function widgetHostCommand(argv: string[]): Promise<number> {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      all: { type: "boolean" },
      follow: { type: "boolean", short: "f" },
      json: { type: "boolean" },
      theme: { type: "string" },
      size: { type: "string" },
      placement: { type: "string" },
      ...Object.fromEntries(PERMISSION_KEYS.map((k) => [k, { type: "string" as const, multiple: true as const }])),
    },
  });
  const [sub, target, ...rest] = positionals;
  if (!target) {
    console.error(red(`usage:\n${WIDGET_HOST_HELP}`));
    return 1;
  }
  const conn = await connect().catch(() => null);
  if (!conn) {
    console.error(red(`no core running at ${defaultSocketPath()}`));
    return 2;
  }
  const client = conn.client;
  try {
    switch (sub) {
      case "grant": {
        let permissions: WidgetPermissions | undefined;
        if (!o.all) {
          permissions = noPermissions();
          const given = o as unknown as Record<string, string[] | undefined>;
          for (const k of PERMISSION_KEYS) permissions[k] = (given[k] ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
          if (!PERMISSION_KEYS.some((k) => permissions![k].length)) {
            console.error(red("say what to grant: --all, or --net HOST, --workspace read, …"));
            return 1;
          }
        }
        const g = await client.call("widget.grant", { name: target, ...(permissions ? { permissions } : {}) });
        if (o.json) console.log(JSON.stringify(g, null, 2));
        else {
          const what = PERMISSION_KEYS.filter((k) => g.permissions[k].length).map((k) => `${k}: ${g.permissions[k].join(", ")}`);
          console.log(`${target} ${g.version} may use ${what.length ? what.join("; ") : "nothing beyond its own window"}`);
        }
        return 0;
      }
      case "restart":
        await client.call("widget.restart", { windowId: target });
        return 0;
      case "press": {
        const handler = Number(rest[0]);
        if (!Number.isInteger(handler)) {
          console.error(red("usage: cmd widget press <window> <handler> [event] [value]"));
          return 1;
        }
        const raw = rest[2];
        let value: unknown = raw;
        if (raw !== undefined)
          try {
            value = JSON.parse(raw);
          } catch {}
        await client.call("widget.interact", { windowId: target, handler, event: rest[1] ?? "onClick", ...(raw === undefined ? {} : { value }) });
        return 0;
      }
      case "env": {
        const theme = o.theme === "light" ? "light" : "dark";
        const size = o.size === "narrow" || o.size === "wide" ? o.size : "regular";
        const placement = o.placement === "sidebar" ? "sidebar" : "board";
        await client.call("widget.env", { windowId: target, theme, size, placement });
        return 0;
      }
      case "tree": {
        const show = (e: CoreEvent) => {
          if (e.type !== "widget.tree" || e.windowId !== target) return false;
          const m = e.message;
          if (o.json) console.log(JSON.stringify(m));
          else if (m.kind === "status") console.log(dim(`· ${m.state}${m.reason ? ` · ${m.reason}` : ""}`));
          else if (m.kind === "tree") console.log(treeLines(m.nodes).join("\n"));
          else console.log(dim(`patch ${m.rev}: ${m.ops.map((op) => op.op).join(", ")}`));
          return m.kind === "tree" || (m.kind === "status" && m.state !== "running");
        };
        let done: () => void = () => {};
        const finished = new Promise<void>((r) => (done = r));
        client.onEvent((e) => {
          if (show(e) && !o.follow) done();
        });
        await client.call("events.subscribe", { types: ["widget.tree"] });
        await client.call("widget.resync", { windowId: target });
        await (o.follow ? new Promise(() => {}) : Promise.race([finished, new Promise((r) => setTimeout(r, 5000))]));
        return 0;
      }
    }
    return 1;
  } finally {
    conn.close();
  }
}
