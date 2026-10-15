// `cmd widget`: widget packages (docs/56) from a terminal. `new`, `dev`, `test`, `check` and
// `preview` are the developer loop (widget-new.ts, widget-dev.ts, widget-preview.ts; check runs
// the toolchain Magic checks with); `list` and `add` ask the running core about the Widget
// Library (docs/16-widgets.md); `link` and `unlink` put one in the Library from its folder and
// take it out (widget-link.ts); grant, restart, tree, press and env drive a package window's
// process (widget-host.ts).

import path from "node:path";
import { parseArgs } from "node:util";
import { ENV, type WidgetEntry } from "@cmd/protocol";
import { connect, defaultSocketPath } from "@cmd/protocol/node";
import { checkoutToolchain, writeEnvTypes } from "@cmd/core/magic";
import { cmdVersion, readPackage, type WidgetPackage } from "@cmd/core/widgets/package";
import { missingPage, missingPages } from "@cmd/core/widgets/pages";
import { shippedFiles } from "@cmd/core/widgets/shipped";
import { HOST_SUBS, WIDGET_HOST_HELP, widgetHostCommand } from "./widget-host.ts";
import { LINK_SUBS, WIDGET_LINK_HELP, widgetLinkCommand } from "./widget-link.ts";
import { newPackage, NO_SANDBOX, testPackage, toolSandbox } from "./widget-new.ts";
import { dim, green, red } from "./magic.ts";

export const WIDGET_HELP = `cmd widget — make, check and run widget packages

usage: cmd widget new <name>        a package from the template, in ./<name>: a widget with a list
                                   and a toolbar, its test, its story, CLAUDE.md for agents
       cmd widget dev [dir]         link it, put it on the board and print its console; saves
                                   reload it (Ctrl-C stops printing, the widget stays)
       cmd widget test [dir]        its tests: the package's test script (vitest run)
       cmd widget check [dir]       package.json, permissions and types; writes cmd-env.d.ts,
                                   which types useConfig() from the config fields
       cmd widget preview [dir] [--themes all|dark|light] [--sizes all|narrow|regular|wide]
                                   draw each state of its story; exits 2 on overflow, an empty
                                   state where the story has data, or console errors
       cmd widget list             the Widget Library: built-in widgets, then packages
       cmd widget add <widget>     put one in this terminal's workspace: a ref from list,
                                   or a title
${WIDGET_LINK_HELP}
${WIDGET_HOST_HELP}

  --force              unlink: remove a package that isn't a link
  --out <dir>          preview: where the shots go (default <dir>/.cmd-preview)
  --json               machine-readable output

dir defaults to the current folder. Magic makes packages too: cmd magic --help.`;

/** Every subcommand, as the help lists them. */
export const WIDGET_SUBS = ["new", "dev", "test", "check", "preview", "list", "add", ...LINK_SUBS, ...HOST_SUBS];

export async function widgetCommand(argv: string[]): Promise<number> {
  if (HOST_SUBS.includes(argv[0] ?? "") && !argv.includes("--help") && !argv.includes("-h")) return widgetHostCommand(argv);
  if (LINK_SUBS.includes(argv[0] ?? "") && !argv.includes("--help") && !argv.includes("-h")) return widgetLinkCommand(argv);
  if (argv[0] === "dev" && !argv.includes("--help") && !argv.includes("-h")) return (await import("./widget-dev.ts")).devCommand(argv.slice(1));
  if (argv[0] === "preview" && !argv.includes("--help") && !argv.includes("-h")) return (await import("./widget-preview.ts")).previewCommand(argv.slice(1));
  // Everything after the folder goes to Vitest (cmd widget test . -t "name").
  if (argv[0] === "test" && !argv.includes("--help") && !argv.includes("-h")) {
    const [dir, ...rest] = argv.slice(1);
    const hasDir = dir !== undefined && !dir.startsWith("-");
    return testPackage(path.resolve(hasDir ? dir : "."), hasDir ? rest : argv.slice(1));
  }
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
  if (sub === "new") return newPackage(dirArg, process.cwd());

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
 * `cmd widget check` on a widget package: 0 when it's valid, 2 with each problem (its field, or
 * its file and line, first) when not. package.json through readPackage, then cmd-env.d.ts written
 * from its config, then TypeScript over src/ (the toolchain Magic checks with; skipped, and said,
 * where this cmd has none, or with `types: false`). engines.cmd is checked against this cmd's
 * version, else the running core's, else not at all (and it says so). A Frame's `src="….html"`
 * written in src/ that names no file of the package is a warning (a typo, or a page not built yet),
 * and so is, in a package that lists `files`, what wouldn't ship: a listed file that isn't there,
 * a main or view.html left out, a relative import of a file that isn't listed (widgets/shipped.ts).
 */
export async function checkPackage(dir: string, json: boolean, local: string | null = cmdVersion(), ask: () => Promise<string | null> = coreVersion, o: { types?: boolean } = {}): Promise<number> {
  const version = local ?? (await ask());
  if (!version) process.stderr.write(dim("engines.cmd not checked: no cmd running\n"));
  const tools = o.types === false ? null : checkoutToolchain();
  const sandbox = tools ? toolSandbox() : null;
  // package.json is read once: by the toolchain's check where there is one, else here.
  let pkg: WidgetPackage | null;
  let problems: string[];
  let types: "checked" | "skipped" = "skipped";
  if (tools && sandbox) {
    const c = await tools.check(dir, { sandbox, deny: [], cmdVersion: version });
    ({ pkg, problems, types } = c);
  } else {
    const r = readPackage(dir, { cmdVersion: version });
    [pkg, problems] = r.ok ? [r.pkg, []] : [null, r.errors];
    if (tools) problems.push(NO_SANDBOX);
    else if (o.types !== false) process.stderr.write(dim("types not checked: this cmd has no TypeScript to check with\n"));
  }
  if (pkg) writeEnvTypes(dir, pkg);
  const warnings = pkg ? [...missingPages(dir).map((m) => `${m.file}:${m.line}: ${missingPage(m.src)}`), ...(shippedFiles(dir)?.problems ?? [])] : [];
  if (!json) for (const w of warnings) process.stderr.write(`${dim("warning")} ${w}\n`);
  const ok = !problems.length;
  if (json) console.log(JSON.stringify(pkg && ok ? { ok: true, name: pkg.name, version: pkg.version, api: pkg.api, kinds: pkg.widgets.map((w) => w.kind), types, ...(warnings.length ? { warnings } : {}) } : { ok: false, problems }));
  else if (pkg && ok) console.log(`${green("✓")} ${pkg.name} ${pkg.version} ${dim(`· API ${pkg.api} · ${pkg.widgets.map((w) => w.kind).join(", ")}${types === "checked" ? " · types" : ""}`)}`);
  else {
    const where = pkg ? "" : " in package.json";
    // TypeScript's continuation lines are indented: count the problems, not the lines.
    const n = problems.filter((p) => !/^\s/.test(p)).length;
    console.error(`${red("✗")} ${path.basename(dir)} ${dim(`· ${n} ${n === 1 ? "problem" : "problems"}${where}`)}`);
    for (const e of problems) console.error(red(`  ${e}`));
  }
  return ok ? 0 : 2;
}

/** A widget by its ref, its kind (the ref without "type:"), or its title (any case). */
export function findWidget(entries: WidgetEntry[], q: string): WidgetEntry | undefined {
  const lower = q.trim().toLowerCase();
  return entries.find((e) => e.ref === q || e.ref.slice(e.ref.indexOf(":") + 1) === q) ?? entries.find((e) => e.title.toLowerCase() === lower);
}
