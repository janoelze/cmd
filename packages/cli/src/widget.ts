// `cmd widget`: the widget toolchain (docs/14-magic-v2.md), the same checks the
// Magic agent and the core run, for a widget folder anywhere: make one, check
// it (types, a data run, renders), run its data, render it. So a widget can be
// built by hand or by any coding agent (Claude Code, Codex) with cmd's rules.
// `list` and `add` ask the running core about the Widget Library (docs/16-widgets.md).

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ENV, type WidgetEntry } from "@cmd/protocol";
import { connect, defaultSocketPath } from "@cmd/protocol/node";
import { PREVIEW_THEMES, PROMPT_DIR, RUNTIME_DIR, checkWidget, previewCases, previewPage, previewRender, runWidgetData, verifyWidget, writeDenoConfig } from "@cmd/core/magic";
import { bold, dim, openFile, printVerdict, red, sandboxNote, widgetContext } from "./magic.ts";

export const WIDGET_HELP = `cmd widget — make, check, run and preview Magic widgets

usage: cmd widget new <dir>        a new widget folder (manifest.json, data.ts, view.html, view.ts),
                                   with notes for coding agents (CLAUDE.md, AGENTS.md)
       cmd widget check [dir]      everything cmd checks before it shows a widget: manifest, types,
                                   a data run (kept as fixtures/live.json), renders with every fixture
       cmd widget run [dir]        run data.ts once and print its data (validated against its schema)
       cmd widget preview [dir]    render it (dark, light, small) and save preview-*.png in the folder
       cmd widget list             the Widget Library: built-in widgets, then yours by last use
       cmd widget add <widget>     put one in this terminal's Space: a ref from list,
                                   a widget id, or a title

  --config key=value   a config value for the run (repeatable)
  --cwd DIR            where run() starts by default (default: the current folder)
  --unsandboxed        run without sandbox-exec (Deno's permissions still apply)
  --open               open the screenshot (preview)
  --json               machine-readable output

dir defaults to the current folder.`;

const TEMPLATE: Record<string, string> = {
  "manifest.json": `{
  "cmd": 2,
  "kind": "widget",
  "title": "My widget",
  "size": "m",
  "refresh": 60,
  "permissions": { "net": [], "run": [], "env": [], "read": [] },
  "config": []
}
`,
  "data.ts": `import { s, type Infer } from "cmd";

export const schema = s.object({
  message: s.string(),
  at: s.number(),
});
export type Data = Infer<typeof schema>;

export default async function data(): Promise<Data> {
  return { message: "Hello from data.ts", at: Date.now() };
}
`,
  "view.html": `<div class="k-stack">
  <div class="k-row"><span class="k-dot k-good"></span><b id="message">–</b></div>
  <div class="k-dim k-small" id="at"></div>
</div>
`,
  "view.ts": `import type { Data } from "./data.ts";

const $ = (id: string) => document.getElementById(id)!;

cmd.onData<Data>((d) => {
  $("message").textContent = d.message;
  $("at").textContent = cmd.fmt.time(d.at);
});
`,
};

function agentNotes(): string {
  return `# A cmd Magic widget

This folder is one of cmd's Magic widgets. The full contract (files, the
\`cmd\` module for data.ts, the view's \`cmd\` object, the kit's CSS classes and
how widgets should look) is in:

  ${path.join(PROMPT_DIR, "prompt.md")}

Finished examples: ${path.join(PROMPT_DIR, "examples")}/

Work like this:
1. Edit manifest.json, data.ts, view.html and view.ts.
2. \`cmd widget check\`: manifest, types (view.ts against data.ts's schema), a data run, and renders with
   every fixture. Fix everything it reports.
3. \`cmd widget preview --open\`: look at it, dark and light.

data.ts runs in Deno with only the permissions in manifest.json, no imports but "cmd".
view.ts may only \`import type\` from ./data.ts.
`;
}

function configArgs(list: string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of list ?? []) {
    const i = kv.indexOf("=");
    if (i < 1) throw new Error(`--config ${kv}: expected key=value`);
    const v = kv.slice(i + 1);
    out[kv.slice(0, i)] = v === "true" ? true : v === "false" ? false : v !== "" && !isNaN(Number(v)) ? Number(v) : v;
  }
  return out;
}

export async function widgetCommand(argv: string[]): Promise<number> {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", multiple: true },
      cwd: { type: "string" },
      unsandboxed: { type: "boolean" },
      open: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [sub, dirArg] = positionals;
  if (o.help || !sub) {
    console.log(WIDGET_HELP);
    return o.help ? 0 : 1;
  }
  const unsandboxed = !!o.unsandboxed || process.env.CMD_MAGIC_UNSANDBOXED === "1";

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
        for (const e of entries) console.log(`${e.ref.padEnd(44)} ${e.title}${e.windows.length ? dim(`  in a Space${e.windows.length > 1 ? ` ×${e.windows.length}` : ""}`) : ""}`);
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

  const dir = path.resolve(dirArg ?? ".");
  if (sub === "new") {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
      console.error(red(`${dir} isn't empty`));
      return 1;
    }
    fs.mkdirSync(path.join(dir, "fixtures"), { recursive: true });
    for (const [f, text] of Object.entries(TEMPLATE)) fs.writeFileSync(path.join(dir, f), text);
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), agentNotes());
    fs.writeFileSync(path.join(dir, "AGENTS.md"), agentNotes());
    writeDenoConfig(dir);
    console.log(dir);
    process.stderr.write(dim(`  next: edit the files, then cmd widget check ${path.relative(process.cwd(), dir) || "."}\n`));
    return 0;
  }

  if (!fs.existsSync(path.join(dir, "manifest.json"))) {
    console.error(red(`${dir} has no manifest.json (make one with: cmd widget new <dir>)`));
    return 1;
  }
  let config: Record<string, unknown>;
  try {
    config = configArgs(o.config);
  } catch (e) {
    console.error(red((e as Error).message));
    return 1;
  }
  sandboxNote(unsandboxed);
  const ctx = await widgetContext(dir, { unsandboxed, config, cwd: o.cwd ? path.resolve(o.cwd) : undefined, preview: sub !== "run" });
  writeDenoConfig(dir);

  if (sub === "run") {
    const st = ctx.store.manifest(ctx.id);
    if (!st.ok) {
      console.error(red(`manifest.json: ${st.errors.join("; ")}`));
      return 1;
    }
    const d = await runWidgetData(ctx, st.manifest);
    if (d.none) {
      console.error(dim("no data.ts (and no static.json)"));
      return 0;
    }
    if (!d.ok) {
      console.error(red(d.problem ?? "failed"));
      for (const i of d.result?.issues ?? []) console.error(red(`  ${i.path || "(root)"}: ${i.message}`));
      if (d.result?.stderr) console.error(dim(d.result.stderr));
      return 1;
    }
    console.log(JSON.stringify(d.data, null, o.json ? 0 : 2));
    if (d.result?.stderr) console.error(dim(d.result.stderr));
    return 0;
  }

  if (sub === "preview") {
    const st = await checkWidget(ctx);
    if (!st.manifest || st.manifest.kind !== "widget") {
      console.error(red(st.problems[0] ?? "a terminal widget has no view"));
      return 1;
    }
    if (!ctx.previewer) {
      console.error(red("rendering needs Playwright (pnpm install in a cmd checkout)"));
      return 1;
    }
    const live = ctx.store.fixtures(ctx.id).find((f) => f.name === "live")?.data ?? ctx.store.staticData(ctx.id);
    const cases = previewCases(st.manifest, live, ctx.store.fixtures(ctx.id)).map((c) => ({ ...c, shot: true }));
    const m = st.manifest;
    const shots = await ctx.previewer.render(cases.map((c) => ({ page: previewPage(st.html, c.data, PREVIEW_THEMES[c.theme], m.media), width: c.size[0], height: c.size[1], shot: true })));
    const files: string[] = [];
    shots.forEach((s, i) => {
      if (!s.png) return;
      const name = `preview-${cases[i]!.label.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}.png`;
      fs.writeFileSync(path.join(dir, name), Buffer.from(s.png, "base64"));
      files.push(path.join(dir, name));
    });
    const report = await previewRender(ctx.previewer, st.html, st.manifest, cases.map((c) => ({ ...c, shot: false })));
    for (const p of report.problems) process.stderr.write(red(`  ${p}\n`));
    for (const w of report.warnings) process.stderr.write(dim(`  ${w}\n`));
    for (const f of files) console.log(f);
    if (o.open && files[0]) openFile(files[0]);
    return report.ok ? 0 : 1;
  }

  if (sub === "check") {
    process.stderr.write(`${bold("✦")} ${path.basename(dir)} ${dim(`· deno ${ctx.deno ? "✓" : "missing"} · previews ${ctx.previewer ? ctx.previewer.name : "off"} · runtime ${RUNTIME_DIR}`)}\n`);
    const v = await verifyWidget(ctx);
    if (o.json) console.log(JSON.stringify({ ok: v.ok, usable: v.usable, problems: v.problems, warnings: v.warnings }));
    const ok = printVerdict(v);
    if (v.shot) {
      const shot = path.join(dir, "preview-live-data-dark.png");
      fs.writeFileSync(shot, Buffer.from(v.shot, "base64"));
      process.stderr.write(dim(`  ${shot}\n`));
      if (o.open) openFile(shot);
    }
    return ok ? 0 : 1;
  }

  console.error(red(`unknown: cmd widget ${sub}`));
  console.log(WIDGET_HELP);
  return 1;
}

/** A widget by its ref, its id or kind (the ref without "magic:"/"type:"), or its title (any case). */
export function findWidget(entries: WidgetEntry[], q: string): WidgetEntry | undefined {
  const lower = q.trim().toLowerCase();
  return entries.find((e) => e.ref === q || e.ref.slice(e.ref.indexOf(":") + 1) === q) ?? entries.find((e) => e.title.toLowerCase() === lower);
}
