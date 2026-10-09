// Settings file: load, validate, watch for edits, write changes.
// The file is the source of truth, so hand edits and `cmd settings set` agree.
// Core consumers that cache something derived from settings bind() to its keys.
// A file that doesn't parse (mid hand edit) keeps the last good values and is
// never written over; writes change one key in the text, so comments survive.

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { logger } from "@cmd/protocol/node";
import {
  currentKey,
  editJsonc,
  isSettingKey,
  RENAMED_SETTINGS,
  parseJsoncObject,
  resolveSettings,
  SETTINGS_TEMPLATE,
  validateSetting,
  type SettingKey,
  type Settings,
  type SettingsSnapshot,
} from "@cmd/protocol";

const log = logger("settings");

export class SettingsService extends EventEmitter<{ updated: [SettingsSnapshot] }> {
  readonly path: string;
  #snapshot: SettingsSnapshot;
  /** The file's settings as last read when it parsed. */
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

  /** Run fn now and again whenever one of keys changes value. Returns an unsubscribe. */
  bind(keys: readonly SettingKey[], fn: (settings: Settings) => void): () => void {
    let prev = this.settings;
    const onUpdated = ({ settings }: SettingsSnapshot) => {
      const changed = keys.some((k) => settings[k] !== prev[k]);
      prev = settings;
      if (changed) fn(settings);
    };
    this.on("updated", onUpdated);
    fn(prev);
    return () => void this.off("updated", onUpdated);
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
    // The poll's baseline stat is async: a write that lands before it is never seen as a change.
    setTimeout(() => this.reload(), 1000).unref();
  }

  reload(): void {
    const next = this.#load();
    if (JSON.stringify(next) === JSON.stringify(this.#snapshot)) return;
    this.#snapshot = next;
    this.emit("updated", next);
  }

  /** Old key names are accepted, and writing a key drops its old names from the file. */
  set(key: string, value: unknown): SettingsSnapshot {
    key = currentKey(key);
    const r = validateSetting(key, value);
    if ("error" in r) throw new Error(r.error);
    return this.#write(key, r.value);
  }

  reset(key: string): SettingsSnapshot {
    key = currentKey(key);
    if (!isSettingKey(key)) throw new Error(`unknown setting "${key}"`);
    return this.#write(key, undefined);
  }

  close(): void {
    this.#watcher?.close();
    if (this.path) fs.unwatchFile(this.path);
    clearTimeout(this.#debounce);
  }

  #load(): SettingsSnapshot {
    let errors: string[] = [];
    if (this.path) {
      try {
        this.#raw = parseJsoncObject(fs.readFileSync(this.path, "utf8"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") this.#raw = {};
        else errors.push(`${this.#name}: ${(err as Error).message}. Settings stay as they were until it's fixed.`);
      }
    }
    const resolved = resolveSettings(this.#raw);
    errors = [...errors, ...resolved.errors];
    for (const e of errors) log.warn(e);
    return { settings: resolved.settings, overrides: overridesOf(this.#raw), errors, path: this.path };
  }

  get #name(): string {
    return path.basename(this.path);
  }

  /** Set key (undefined: remove it) and drop its old names. Edits the file as it is now, not as last loaded. */
  #write(key: string, value: unknown): SettingsSnapshot {
    if (!this.path) {
      const raw = Object.fromEntries(Object.entries(this.#raw).filter(([k]) => k !== key && RENAMED_SETTINGS[k] !== key));
      if (value !== undefined) raw[key] = value;
      this.#raw = raw;
      this.#snapshot = this.#fromRaw(raw);
      this.emit("updated", this.#snapshot);
      return this.#snapshot;
    }
    let text = "";
    try {
      text = fs.readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Couldn't read ${this.#name}: ${(err as Error).message}`);
    }
    let raw: Record<string, unknown>;
    try {
      raw = parseJsoncObject(text);
    } catch (err) {
      this.reload(); // the snapshot says so too
      throw new Error(`${this.#name}: ${(err as Error).message}. Fix it first.`);
    }
    const changes: Record<string, unknown> = Object.fromEntries(Object.keys(raw).filter((k) => RENAMED_SETTINGS[k] === key).map((k) => [k, undefined]));
    changes[key] = value;
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    fs.writeFileSync(tmp, editJsonc(text, changes, SETTINGS_TEMPLATE));
    fs.renameSync(tmp, this.path);
    this.#snapshot = this.#load();
    this.emit("updated", this.#snapshot);
    return this.#snapshot;
  }

  #fromRaw(raw: Record<string, unknown>): SettingsSnapshot {
    const r = resolveSettings(raw);
    return { settings: r.settings, overrides: overridesOf(raw), errors: r.errors, path: "" };
  }
}

function overridesOf(raw: Record<string, unknown>): SettingKey[] {
  return [...new Set(Object.keys(raw).map(currentKey))].filter(isSettingKey);
}
