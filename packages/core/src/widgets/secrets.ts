// Widget secrets: values of config fields marked `secret` in manifest.json (an
// API token a widget's data.ts needs). Kept per window in
// $CMD_HOME/widget-secrets.json (mode 0600), never in the widget folder, the
// window state or anything sent to a client or the model. data.ts gets them in
// its config; clients only see which are set.

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

  get(windowId: string): Record<string, string> {
    return { ...this.#values[windowId] };
  }

  /** Which keys are set (for the settings pane). */
  status(windowId: string): Record<string, boolean> {
    return Object.fromEntries(Object.keys(this.#values[windowId] ?? {}).map((k) => [k, true]));
  }

  set(windowId: string, key: string, value: string | null): void {
    const cur = { ...this.#values[windowId] };
    const v = value?.trim();
    if (v) cur[key] = v;
    else delete cur[key];
    this.#values = { ...this.#values, [windowId]: cur };
    if (!Object.keys(cur).length) delete this.#values[windowId];
    this.#save();
  }

  forget(windowId: string): void {
    if (!(windowId in this.#values)) return;
    delete this.#values[windowId];
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
