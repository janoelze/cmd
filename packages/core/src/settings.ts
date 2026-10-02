// Settings file: load, validate, watch for edits, write changes.
// The file is the source of truth, so hand edits and `cmd settings set` agree.

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  isSettingKey,
  parseJsonc,
  resolveSettings,
  validateSetting,
  type SettingKey,
  type Settings,
  type SettingsSnapshot,
} from "@cmd/protocol";

const TEMPLATE = `// cmd settings. Keys and defaults: \`cmd settings\` or ⌘, in the app.
// Changes apply live.
{
}
`;

export class SettingsService extends EventEmitter<{ updated: [SettingsSnapshot] }> {
  readonly path: string;
  #snapshot: SettingsSnapshot;
  #raw: Record<string, unknown> = {};
  #watcher: fs.FSWatcher | null = null;
  #debounce: NodeJS.Timeout | undefined;

  /** file = null keeps settings in memory only (tests). */
  constructor(file: string | null) {
    super();
    this.path = file ?? "";
    this.#snapshot = this.#load();
  }

  get settings(): Settings {
    return this.#snapshot.settings;
  }

  snapshot(): SettingsSnapshot {
    return this.#snapshot;
  }

  /** Watch the directory, not the file: editors often replace the file on save. */
  watch(): void {
    if (!this.path || this.#watcher) return;
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    this.#watcher = fs.watch(path.dirname(this.path), (_e, name) => {
      if (name && name !== path.basename(this.path)) return;
      clearTimeout(this.#debounce);
      this.#debounce = setTimeout(() => this.reload(), 100);
    });
    this.#watcher.unref();
    // FSEvents can miss changes (e.g. right after the watch starts); poll as a backstop.
    fs.watchFile(this.path, { interval: 1000, persistent: false }, () => this.reload());
  }

  reload(): void {
    const next = this.#load();
    if (JSON.stringify(next) === JSON.stringify(this.#snapshot)) return;
    this.#snapshot = next;
    this.emit("updated", next);
  }

  set(key: string, value: unknown): SettingsSnapshot {
    const r = validateSetting(key, value);
    if ("error" in r) throw new Error(r.error);
    return this.#write({ ...this.#raw, [key]: r.value });
  }

  reset(key: string): SettingsSnapshot {
    if (!isSettingKey(key)) throw new Error(`unknown setting "${key}"`);
    const { [key]: _removed, ...rest } = this.#raw;
    return this.#write(rest);
  }

  close(): void {
    this.#watcher?.close();
    if (this.path) fs.unwatchFile(this.path);
    clearTimeout(this.#debounce);
  }

  #load(): SettingsSnapshot {
    let errors: string[] = [];
    this.#raw = {};
    if (this.path) {
      try {
        const text = fs.readFileSync(this.path, "utf8");
        const parsed = parseJsonc(text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) this.#raw = parsed as Record<string, unknown>;
        else errors.push("settings file must contain a JSON object");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`could not read settings: ${(err as Error).message}`);
      }
    }
    const resolved = resolveSettings(this.#raw);
    errors = [...errors, ...resolved.errors];
    const overrides = Object.keys(this.#raw).filter(isSettingKey) as SettingKey[];
    return { settings: resolved.settings, overrides, errors, path: this.path };
  }

  // Note: rewriting the file drops comments. Fine for now; a JSONC-preserving
  // editor (e.g. jsonc-parser's modify) can replace this later.
  #write(raw: Record<string, unknown>): SettingsSnapshot {
    if (this.path) {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const sorted = Object.fromEntries(Object.entries(raw).sort(([a], [b]) => a.localeCompare(b)));
      const body = Object.keys(sorted).length ? JSON.stringify(sorted, null, 2) : "{\n}";
      const tmp = `${this.path}.tmp`;
      fs.writeFileSync(tmp, TEMPLATE.replace("{\n}", body));
      fs.renameSync(tmp, this.path);
    } else {
      this.#raw = raw;
    }
    this.#snapshot = this.path ? this.#load() : this.#fromRaw(raw);
    this.emit("updated", this.#snapshot);
    return this.#snapshot;
  }

  #fromRaw(raw: Record<string, unknown>): SettingsSnapshot {
    const r = resolveSettings(raw);
    return { settings: r.settings, overrides: Object.keys(raw).filter(isSettingKey) as SettingKey[], errors: r.errors, path: "" };
  }
}
