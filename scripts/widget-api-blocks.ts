// The lists in the prose agents read about the widget API, generated (docs/56, "Magic on
// V3"): Magic's prompt (packages/core/src/magic/prompt/prompt.md) and the CLAUDE.md that
// `cmd widget new` writes (packages/cli/templates/widget/CLAUDE.md) teach composition and
// judgement in words, and name the API's lists (the live hooks, the toolbar's items, the
// permission keys with their values, a frame page's `cmd`, storage's scopes and quotas) between `<!-- gen:<name> -->` and `<!-- /gen:<name> -->`
// markers, filled from the rows the core enforces: protocol widget-verbs.ts, widget-elements.ts,
// widget-package.ts's keys and the core's data/policy.ts. Both strip the markers where they
// are read (magic/package/prompt.ts, cli widget-new.ts). packages/core/test/magic-prompt.test.ts
// fails when a block is stale, and checks the names the prose around them uses.
//
//   node scripts/widget-api-blocks.ts           write the blocks (pnpm widget-api:docs runs it)
//   node scripts/widget-api-blocks.ts --check   exit 1 when one is stale

import fs from "node:fs";
import path from "node:path";
import { API, API_ACT_VERBS, API_AI_USES, API_ELEMENTS, API_MEDIA_USES, API_TOPICS, type ApiNeed, type ApiVerb } from "../packages/protocol/src/widget-tree.ts";
import { PERMISSION_KEYS } from "../packages/protocol/src/widget-package.ts";
import { DATA_CLASSES, type DataClass } from "../packages/protocol/src/events.ts";
import { POLICY, declarable } from "../packages/core/src/data/policy.ts";
import { apiExports } from "./widget-api-docs.ts";
import { STORAGE_LIMITS } from "../packages/core/src/widgets/limits.ts";

const root = path.resolve(import.meta.dirname, "..");
/** The files with blocks. */
export const BLOCK_FILES = [path.join(root, "packages/core/src/magic/prompt/prompt.md"), path.join(root, "packages/cli/templates/widget/CLAUDE.md")];

const q = (s: string) => `\`${s}\``;
const list = (xs: string[], and = "and") => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${and} ${xs.at(-1)}`);
const verbsNeeding = (need: ApiNeed) => (Object.keys(API) as ApiVerb[]).filter((v) => API[v].needs === need);
const namespaces = (verbs: string[]) => [...new Set(verbs.map((v) => v.split(".")[0]!))];

/** The live hooks of cmd's world, one per topic, with the keys of their query: `useAgents({ scope })`. Storage's (useStorage) is the storage block's. */
function liveHooks(): { name: string; keys: string[] }[] {
  const { checker, exported } = apiExports();
  return API_TOPICS.filter((t) => t !== "storage").map((t) => {
    const name = `use${t[0]!.toUpperCase()}${t.slice(1)}`;
    const hook = exported.find((s) => s.name === name);
    if (!hook) throw new Error(`@cmd/widget-api has no ${name} for the topic "${t}"`);
    const param = checker.getTypeOfSymbol(hook).getCallSignatures()[0]?.parameters[0];
    const keys = param ? checker.getNonNullableType(checker.getTypeOfSymbol(param)).getProperties().map((p) => p.name) : [];
    return { name, keys };
  });
}
const LIVE = liveHooks();
const hooks = () => LIVE.map((h) => q(`${h.name}(${h.keys.length ? `{ ${h.keys.join(", ")} }` : ""})`)).join(", ");

/** The toolbar's items: the elements named Toolbar…, in the spec's order. */
const toolbar = () =>
  Object.keys(API_ELEMENTS)
    .filter((e) => e.startsWith("Toolbar"))
    .map(q)
    .join(", ");

/** The event classes a widget names (`events`), and the ones it reads without. */
function eventClasses() {
  const rules = POLICY.widget;
  return { free: declarable("widget").filter((c) => rules[c] === "allow"), named: declarable("widget").filter((c) => rules[c] !== "allow") };
}

/** A class with what it holds, when its name doesn't say: `"ai"` (model calls). */
function gloss(c: DataClass): string {
  const title = DATA_CLASSES[c].title.replace(/^The /, "the ");
  const words = /^the /.test(title) ? title : title.toLowerCase();
  return words === c || words === `${c}s` ? q(`"${c}"`) : `${q(`"${c}"`)} (${words})`;
}

/** One verb alone, as `act` may name it. */
const ONE_ACT = API_ACT_VERBS.includes("terminals.open") ? "terminals.open" : API_ACT_VERBS[0]!;

/** The act values: each namespace with its verbs' names, and one verb alone. */
function acts(): string {
  const byNs = namespaces(API_ACT_VERBS).map((ns) => `${q(`"${ns}"`)} (${API_ACT_VERBS.filter((v) => v.startsWith(`${ns}.`)).map((v) => v.split(".")[1]).join(", ")})`);
  return `${byNs.join(", ")}, or one verb alone (${q(`"${ONE_ACT}"`)})`;
}

/** What each permission key is for, in Magic's words: a key added to PERMISSION_KEYS fails tsc here until it is described. */
function permissionLines(): string[] {
  const ev = eventClasses();
  const ws = namespaces(verbsNeeding("workspace")).map((n) => q(`cmd.${n}`));
  const lines: Record<(typeof PERMISSION_KEYS)[number], string> = {
    net: `hosts ${list(verbsNeeding("net").map((v) => q(`cmd.${v}`)))} may reach (${q('"api.open-meteo.com"')}); no ${q("*")}.`,
    workspace: `${q('["read"]')} to see this workspace's agents, terminals and what they use, windows, git status, Actions and journal (${list(ws)}, and their hooks); ${q('["read", "all"]')} for every workspace's, read with \`{ scope: "all" }\` (${list(LIVE.filter((h) => h.keys.includes("scope")).map((h) => q(h.name)))}, and their verbs).`,
    events: `classes of cmd's event log beyond ${list(ev.free)}, which need none: ${ev.named.map(gloss).join(", ")}; ${q("cmd.stats.query")} needs the class its stat is counted from, ${q("cmd.journal.days")} ${q('"agents"')}.`,
    ai: `${q(JSON.stringify(API_AI_USES))} to use the person's AI (it counts against their usage: only when the request is about it).`,
    run: `the programs ${q("cmd.run")} runs, by name (${q('["ps"]')}, ${q('["gh"]')}); never a shell or an interpreter (sh, node, python).`,
    read: `full paths of folders ${q("cmd.run")} may run in besides the workspace's (${q('["~/Notes"]')}); never the home folder itself or anything private.`,
    media: `${q(JSON.stringify(API_MEDIA_USES))}: ${q('"read"')} to see what the Mac is playing (${q("cmd.media.get")}), ${q('"control"')} to play, pause and skip it after a press (${q("cmd.media.control")}).`,
    act: `what it may ask to do, a namespace or one verb: ${acts()}. Only what a button in the widget does.`,
  };
  const order = ["net", "workspace", "events", "ai", "run", "read", "media", "act"] as const satisfies readonly (typeof PERMISSION_KEYS)[number][];
  const free = verbsNeeding(null);
  const whole = namespaces(free).filter((ns) => (Object.keys(API) as string[]).filter((v) => v.startsWith(`${ns}.`)).every((v) => free.includes(v as ApiVerb)));
  const none = [...whole.map((ns) => q(`cmd.${ns}`)), ...free.filter((v) => !whole.includes(v.split(".")[0]!)).map((v) => q(`cmd.${v}`))];
  return [...order.map((k) => `- ${q(k)}: ${lines[k]}`), `- ${list(none)} need no permission.`];
}

/** The keys as package.json writes them, on one line (CLAUDE.md). */
function permissionKeys(): string {
  const ev = eventClasses();
  const ns = namespaces(API_ACT_VERBS);
  return [
    q("net: [<host>]"),
    q("run: [<program>]"),
    q("read: [<folder>]"),
    `${q('workspace: ["read"]')} (${q('["read", "all"]')} for every workspace)`,
    `${q("events: [<class>]")} (${ev.named.map((c) => `"${c}"`).join(", ")}; ${list(ev.free)} need none)`,
    `${q("act: [<namespace>]")} (${ns.map((c) => `"${c}"`).join(", ")}, or one verb like "${ONE_ACT}")`,
    q(`ai: ${JSON.stringify(API_AI_USES)}`),
    q(`media: ${JSON.stringify(API_MEDIA_USES)}`),
  ].join(", ");
}

/** A frame page's `cmd` (@cmd/widget-api/frame): the process's verbs by name, and its live topics. */
function frame(): string {
  const say = (verb: ApiVerb, args: string) => {
    if (!(verb in API)) throw new Error(`no verb ${verb} for the frame's block`);
    return q(`cmd.${verb}(${args})`);
  };
  return `every verb the widget has, by the same name and with the same permissions (${say("agents.list", "")}, ${say("git.status", "")}, ${say("net.fetch", "url")}, …), and live data as ${q("cmd.<topic>.subscribe(query, fn)")} or ${q("cmd.on(topic, fn, query)")} for ${list(API_TOPICS.map((t) => q(`"${t}"`)))}`;
}

/** Storage (1.3): the scopes, what each holds, the hook and the quotas (core widgets/limits.ts). */
function storage(): string {
  const size = (n: number) => (n >= 1024 * 1024 ? `${n / 1024 / 1024} MB` : `${n / 1024} KB`);
  const verbs = (Object.keys(API) as ApiVerb[]).filter((v) => v.startsWith("storage.")).map((v) => v.split(".")[1]!);
  const args: Record<string, string> = { get: "key", set: "key, value", delete: "key", keys: "prefix", history: "key, value, max" };
  return `${q("cmd.storage.window")} (this window, ${size(STORAGE_LIMITS.window)}; ${q("cmd.state")} and ${q("useStoredState")} are the same data), ${q("cmd.storage.workspace")} (this widget in the window's workspace, ${size(STORAGE_LIMITS.workspace)}) and ${q("cmd.storage.package")} (this widget everywhere, ${size(STORAGE_LIMITS.package)}), each with ${list(verbs.map((v) => q(`${v}(${args[v] ?? ""})`)))}; live in every window at once with ${q("useStorage(scope, key, initial)")}; a value at most ${size(STORAGE_LIMITS.value)}, a key at most ${STORAGE_LIMITS.key} characters`;
}

/** Every block by name. */
export function blocks(): Record<string, string> {
  return { hooks: hooks(), toolbar: toolbar(), permissions: permissionLines().join("\n"), "permission-keys": permissionKeys(), frame: frame(), storage: storage() };
}

/** `text` with each block filled; a block on its own lines keeps the indent of its first marker. */
export function withBlocks(text: string, all = blocks()): string {
  return text.replace(/([ \t]*)<!-- gen:([\w-]+) -->([\s\S]*?)<!-- \/gen:\2 -->/g, (_, indent: string, name: string, body: string) => {
    const b = all[name];
    if (b === undefined) throw new Error(`no block "${name}" (scripts/widget-api-blocks.ts)`);
    const lines = body.startsWith("\n");
    const filled = lines ? `\n${b.split("\n").map((l) => indent + l).join("\n")}\n${indent}` : b;
    return `${indent}<!-- gen:${name} -->${filled}<!-- /gen:${name} -->`;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = blocks();
  let stale = false;
  for (const file of BLOCK_FILES) {
    const now = fs.readFileSync(file, "utf8");
    const next = withBlocks(now, all);
    const rel = path.relative(root, file);
    if (now === next) console.log(`${rel} is up to date`);
    else if (process.argv.includes("--check")) (console.error(`${rel} is stale: pnpm widget-api:docs`), (stale = true));
    else (fs.writeFileSync(file, next), console.log(`wrote ${rel}`));
  }
  if (stale) process.exit(1);
}
