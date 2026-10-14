// A package widget's config and secrets (docs/56, "Configuring a package widget"): the values a
// person sets in a window's Configure sheet (widget.config), checked against the widget's
// `config` fields and merged into the window's `state.config` (the host pushes the new `config`
// to the process on the window's update), and its secret fields (widget.secret), kept per
// package and widget id in $CMD_HOME/widget-packages/<name>/secrets.json (mode 0600), read only
// by the core for cmd.net.fetch's `auth`. A secret's value is never logged, echoed or sent in
// an event; clients learn only which keys are set (widget.secrets, the Library's `secrets`).

import { parsePackageKind, type WidgetConfigField, type WindowId, type WireValue } from "@cmd/protocol";
import { logger, widgetPackageData } from "@cmd/protocol/node";
import path from "node:path";
import type { CoreContext } from "../kernel/context.ts";
import type { ConfigField, PackageWidget } from "./package.ts";
import type { WidgetPackages } from "./packages.ts";
import { WidgetSecrets } from "./secrets.ts";

const log = logger("widgets");

export interface ConfigOptions {
  windows: CoreContext["windows"];
  packages: WidgetPackages;
  stateDir: string | null;
  /** Which secrets are set changed (the Library's entries say it). */
  onChange?: () => void;
}

export class PackageConfig {
  #o: ConfigOptions;
  /** Secrets without a state dir (tests): kept in memory, per package. */
  #memory = new Map<string, WidgetSecrets>();

  constructor(o: ConfigOptions) {
    this.#o = o;
  }

  /** A package's secrets: read from its file each time, so a change reaches the next fetch. */
  secrets(name: string): WidgetSecrets {
    if (this.#o.stateDir) return new WidgetSecrets(path.join(widgetPackageData(this.#o.stateDir, name), "secrets.json"));
    let s = this.#memory.get(name);
    if (!s) this.#memory.set(name, (s = new WidgetSecrets(null)));
    return s;
  }

  /** widget.config: all or nothing; a value refused leaves the window as it was. */
  set(windowId: WindowId, values: Record<string, unknown>): void {
    const w = this.#o.windows.others().find((x) => x.id === windowId);
    const kind = w ? parsePackageKind(w.kind) : null;
    if (!w || !kind) throw new Error(`not a package widget's window: ${windowId}`);
    const widget = this.#widget(kind.name, kind.widget);
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("values: an object of config keys");
    const next: Record<string, WireValue> = { ...((w.state.config as Record<string, WireValue> | undefined) ?? {}) };
    for (const [key, v] of Object.entries(values)) {
      const field = widget.config.find((f) => f.key === key);
      if (!field) throw new Error(`“${key}” isn't a setting of ${widget.title}`);
      if (field.secret) throw new Error(`${field.title} is a secret: set it with widget.secret`);
      const value = coerce(field, v);
      if (value === null) delete next[key];
      else next[key] = value;
    }
    this.#o.windows.update(windowId, { state: { config: next } });
    log.info(`widget ${kind.name}/${widget.id} configured`, { window: windowId, keys: Object.keys(values) });
  }

  /** widget.secret: the value goes to the file and nowhere else (not the log, not an event). */
  setSecret(name: string, widgetId: string, key: string, value: string | null): void {
    const widget = this.#widget(name, widgetId);
    const field = widget.config.find((f) => f.key === key);
    if (!field?.secret) throw new Error(`“${key}” isn't a secret of ${widget.title}`);
    if (value !== null && typeof value !== "string") throw new Error("value: a string, or null to remove it");
    if (value !== null && value.length > 16_384) throw new Error(`${field.title} is too long`);
    this.secrets(name).set(widgetId, key, value);
    log.info(`widget ${name}/${widgetId}: secret ${key} ${value?.trim() ? "set" : "removed"}`);
    this.#o.onChange?.();
  }

  /** The secret fields of a widget that have a value (keys only). */
  secretsSet(name: string, widgetId: string): string[] {
    const widget = this.#widget(name, widgetId);
    const set = this.secrets(name).status(widgetId);
    return widget.config.filter((f) => f.secret && set[f.key]).map((f) => f.key);
  }

  #widget(name: string, widgetId: string): PackageWidget {
    const e = this.#o.packages.list().find((x) => x.ok && x.pkg.name === name);
    const widget = e?.ok ? e.pkg.widgets.find((x) => x.id === widgetId) : undefined;
    if (!widget) throw new Error(`no widget ${widgetId} in package ${name}`);
    return widget;
  }
}

/** A value for a field, as its type says: null resets it (null, "", undefined); anything else that doesn't fit is refused. */
export function coerce(field: ConfigField, v: unknown): WireValue | null {
  if (v === null || v === undefined || v === "") return null;
  const bad = () => new Error(`${field.title}: ${JSON.stringify(v).slice(0, 80)} isn't ${field.type === "enum" ? `one of ${(field.options ?? []).join(", ")}` : `a ${field.type === "boolean" ? "yes or no" : field.type}`}`);
  switch (field.type) {
    case "string":
      if (typeof v === "string") return v.slice(0, 4096);
      if (typeof v === "number" || typeof v === "boolean") return String(v);
      throw bad();
    case "number": {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.trim()) : NaN;
      if (!Number.isFinite(n)) throw bad();
      return n;
    }
    case "boolean":
      if (typeof v === "boolean") return v;
      if (v === "true" || v === "false") return v === "true";
      throw bad();
    case "enum":
      if (typeof v === "string" && (field.options ?? []).includes(v)) return v;
      throw bad();
  }
}

/** A widget's fields as the app's Configure sheet gets them (where a secret goes, never how). */
export function configFields(widget: PackageWidget): WidgetConfigField[] {
  return widget.config.map(({ header: _h, scheme: _s, ...f }) => f);
}
