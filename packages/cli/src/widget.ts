// `cmd widget`: widget packages (docs/56) from a terminal. `list` and `add` ask the running
// core about the Widget Library (docs/16-widgets.md); `check` checks a package's package.json
// (Magic's own builds check types, tests and trees too); `link` and `unlink` put one in the
// Library from its folder and take it out (widget-link.ts); grant, restart, tree, press and env
// drive a package window's process (widget-host.ts).

import path from "node:path";
import { parseArgs } from "node:util";
import { ENV, type WidgetEntry } from "@cmd/protocol";
import { connect, defaultSocketPath } from "@cmd/protocol/node";
import { cmdVersion, readPackage } from "@cmd/core/widgets/package";
import { HOST_SUBS, WIDGET_HOST_HELP, widgetHostCommand } from "./widget-host.ts";
import { LINK_SUBS, WIDGET_LINK_HELP, widgetLinkCommand } from "./widget-link.ts";
import { dim, green, red } from "./magic.ts";

export const WIDGET_HELP = `cmd widget — check, link and add widget packages

usage: cmd widget check [dir]      a widget package's package.json (a "cmd" block): what cmd checks
                                   before it runs one
       cmd widget list             the Widget Library: built-in widgets, then packages
       cmd widget add <widget>     put one in this terminal's workspace: a ref from list,
                                   or a title
${WIDGET_LINK_HELP}
${WIDGET_HOST_HELP}

  --force              unlink: remove a package that isn't a link
  --json               machine-readable output

dir defaults to the current folder. Magic makes packages: cmd magic --help.`;

export async function widgetCommand(argv: string[]): Promise<number> {
  if (HOST_SUBS.includes(argv[0] ?? "") && !argv.includes("--help") && !argv.includes("-h")) return widgetHostCommand(argv);
  if (LINK_SUBS.includes(argv[0] ?? "") && !argv.includes("--help") && !argv.includes("-h")) return widgetLinkCommand(argv);
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [sub, dirArg] = positionals;
  if (o.help || !sub) {
    console.log(WIDGET_HELP);
    return o.help ? 0 : 1;
  }

  if (sub === "list" || sub === "add") {
    const conn = await connect().catch(() => null);
    if (!conn) {
      console.error(red(`no core running at ${defaultSocketPath()}`));
      return 2;
    }
    try {
      const entries = await conn.client.call("widget.list", {});
      if (sub === "list") {
        if (o.json) return console.log(JSON.stringify(entries, null, 2)), 0;
        for (const e of entries) console.log(`${e.ref.padEnd(44)} ${e.title}${e.source === "package" ? dim(e.problem ? `  can't run: ${e.problem}` : `  ${e.name} ${e.version} · API ${e.api}`) : ""}${e.windows.length ? dim(`  in a workspace${e.windows.length > 1 ? ` ×${e.windows.length}` : ""}`) : ""}`);
        // Packages run on Deno: say so when this Mac has none.
        const rt = conn.client.has("magic.runtime") ? await conn.client.call("magic.runtime", {}).catch(() => null) : null;
        if (rt && !rt.deno) console.error(dim("Deno isn't installed, so packages can't run yet. Magic offers to download it with your next widget, or set magic.deno."));
        return 0;
      }
      if (!dirArg) {
        console.error(red("usage: cmd widget add <widget>"));
        return 1;
      }
      const e = findWidget(entries, dirArg);
      if (!e) {
        console.error(red(`no widget ${dirArg} (cmd widget list shows them)`));
        return 1;
      }
      const w = await conn.client.call("widget.add", { ref: e.ref, callerPaneId: process.env[ENV.paneId] || undefined });
      console.log(o.json ? JSON.stringify(w, null, 2) : w.id);
      return 0;
    } finally {
      conn.close();
    }
  }

  if (sub === "check") return await checkPackage(path.resolve(dirArg ?? "."), !!o.json);

  console.error(red(`unknown: cmd widget ${sub}`));
  console.log(WIDGET_HELP);
  return 1;
}

/** The running cmd's version from its core (the packaged CLI knows none of its own); null when no core answers. */
async function coreVersion(): Promise<string | null> {
  const conn = await connect().catch(() => null);
  if (!conn) return null;
  conn.close();
  const app = conn.hello?.app;
  return app && app !== "source" ? app : null;
}

/**
 * `cmd widget check` on a widget package: 0 when it's valid, 2 with each problem (its field first) when not.
 * engines.cmd is checked against this cmd's version, else the running core's, else not at all (and it says so).
 */
export async function checkPackage(dir: string, json: boolean, local: string | null = cmdVersion(), ask: () => Promise<string | null> = coreVersion): Promise<number> {
  const version = local ?? (await ask());
  if (!version) process.stderr.write(dim("engines.cmd not checked: no cmd running\n"));
  const r = readPackage(dir, { cmdVersion: version });
  if (json) console.log(JSON.stringify(r.ok ? { ok: true, name: r.pkg.name, version: r.pkg.version, api: r.pkg.api, kinds: r.pkg.widgets.map((w) => w.kind) } : { ok: false, problems: r.errors }));
  else if (r.ok) console.log(`${green("✓")} ${r.pkg.name} ${r.pkg.version} ${dim(`· API ${r.pkg.api} · ${r.pkg.widgets.map((w) => w.kind).join(", ")}`)}`);
  else {
    console.error(`${red("✗")} ${path.basename(dir)} ${dim(`· ${r.errors.length} ${r.errors.length === 1 ? "problem" : "problems"} in package.json`)}`);
    for (const e of r.errors) console.error(red(`  ${e}`));
  }
  return r.ok ? 0 : 2;
}

/** A widget by its ref, its kind (the ref without "type:"), or its title (any case). */
export function findWidget(entries: WidgetEntry[], q: string): WidgetEntry | undefined {
  const lower = q.trim().toLowerCase();
  return entries.find((e) => e.ref === q || e.ref.slice(e.ref.indexOf(":") + 1) === q) ?? entries.find((e) => e.title.toLowerCase() === lower);
}
