// Examples in the Widget Library (docs/16-widgets.md): finished widgets from
// the Magic prompt's examples (magic/prompt/examples/<name>/) that a person
// can add and then change. Adding one copies its files into a widget of their
// own, with a first revision; adding it again finds that copy.

import fs from "node:fs";
import path from "node:path";
import { PROMPT_DIR } from "../magic/prompt.ts";
import { parseManifest } from "./manifest.ts";
import { isWidgetFile, type WidgetStore } from "./store.ts";

/**
 * The prompt's examples the library offers: widgets that work anywhere. Not
 * the terminal answer, nor the two tied to the prompt's sample project
 * (acme/shop): they would fail as added (and Live Diff covers local changes).
 */
export const LIBRARY_EXAMPLES = ["1-weather", "2-vpn", "3-processes", "4-timer", "8-news", "9-radio"];

export interface WidgetExample {
  name: string;
  title: string;
  /** What it was asked for ("weather in Lisbon"). */
  request: string;
}

const dirOf = (name: string) => path.join(PROMPT_DIR, "examples", name);

export function listExamples(): WidgetExample[] {
  return LIBRARY_EXAMPLES.flatMap((name) => {
    try {
      const m = parseManifest(JSON.parse(fs.readFileSync(path.join(dirOf(name), "manifest.json"), "utf8")));
      const req = /^Request:\s*(.+)$/m.exec(fs.readFileSync(path.join(dirOf(name), "request.md"), "utf8"))?.[1]?.trim() ?? "";
      return m.ok ? [{ name, title: m.manifest.title, request: req }] : [];
    } catch {
      return [];
    }
  });
}

/** Copy an example into the store as widget `id`, with a first revision. */
export function copyExample(store: WidgetStore, name: string, id: string): void {
  const ex = listExamples().find((e) => e.name === name);
  if (!ex) throw new Error(`no such example: ${name}`);
  store.ensure(id);
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dirOf(name), rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (isWidgetFile(r)) store.write(id, r, fs.readFileSync(path.join(dirOf(name), r), "utf8"));
    }
  };
  walk("");
  store.snapshot(id, { prompt: ex.request, ok: true });
  const now = Date.now();
  store.setInfo(id, { title: ex.title, history: [ex.request], from: `example:${name}`, createdAt: now, usedAt: now });
}
