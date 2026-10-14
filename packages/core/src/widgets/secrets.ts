// Widget secrets: values of config fields marked `secret` in a package's package.json (an API
// token for the host it is bound to). One file per package (config.ts: its widget-packages
// folder's secrets.json, mode 0600), never in the package folder, the window state or anything
// sent to a widget, a client or the model; the core attaches them to cmd.net.fetch. Clients
// only see which are set.

import fs from "node:fs";
import path from "node:path";

type All = Record<string, Record<string, string>>;

export class WidgetSecrets {
  readonly file: string | null;
  #values: All = {};

  constructor(file: string | null) {
    this.file = file;
    if (!file) return;
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) this.#values = v as All;
    } catch {}
  }

  get(widgetId: string): Record<string, string> {
    return { ...this.#values[widgetId] };
  }

  /** Which keys are set (for the settings pane). */
  status(widgetId: string): Record<string, boolean> {
    return Object.fromEntries(Object.keys(this.#values[widgetId] ?? {}).map((k) => [k, true]));
  }

  set(widgetId: string, key: string, value: string | null): void {
    const cur = { ...this.#values[widgetId] };
    const v = value?.trim();
    if (v) cur[key] = v;
    else delete cur[key];
    this.#values = { ...this.#values, [widgetId]: cur };
    if (!Object.keys(cur).length) delete this.#values[widgetId];
    this.#save();
  }

  forget(widgetId: string): void {
    if (!(widgetId in this.#values)) return;
    delete this.#values[widgetId];
    this.#save();
  }

  #save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#values, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
  }
}
