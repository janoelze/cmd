// Widget packages (docs/56-widgets-v3.md, "A widget is a package"): what a package may ask
// for, and how its windows are named. The parser is the core's (widgets/package.ts); this is
// what clients share with it. The API major a package is written for is WIDGET_API.

/** What a package asks for (`cmd.permissions`), and what a person granted (grants.json). */
export interface WidgetPermissions {
  /** Hosts it may reach ("api.github.com"). */
  net: string[];
  /** Programs it may run ("gh"). */
  run: string[];
  /** Folders it may read. */
  read: string[];
  /** "read": its workspace's windows, panes and agents; "all": every workspace's. */
  workspace: string[];
  /** Classes of the event log (data/policy.ts's widget row). */
  events: string[];
  /** What it may ask to do ("actions.run", "agents"). */
  act: string[];
  /** cmd's AI, through the core ("complete"); the widget never holds a key. */
  ai: string[];
  /** 1.2: what the Mac plays: "read" (media.get), "control" (media.control). */
  media: string[];
}

export const PERMISSION_KEYS = ["net", "run", "read", "workspace", "events", "act", "ai", "media"] as const satisfies readonly (keyof WidgetPermissions)[];

export const noPermissions = (): WidgetPermissions => ({ net: [], run: [], read: [], workspace: [], events: [], act: [], ai: [], media: [] });

/**
 * A config field of a package's widget (`cmd.widgets[].config`), as the app's Configure sheet
 * shows it: a secret field says only the host it is sent to, never its value.
 */
export interface WidgetConfigField {
  key: string;
  title: string;
  type: "string" | "number" | "boolean" | "enum";
  default?: string | number | boolean;
  options?: string[];
  description?: string;
  /** Kept in cmd's secrets, set with widget.secret; the widget never gets it. */
  secret?: boolean;
  /** A secret's host: the only one it is sent to. */
  host?: string;
}

/**
 * A window's config as its widget gets it: each field's default under the person's value
 * (`set`, the window's state; null or missing is unset), never a secret. The one rule for the
 * core's host, the frame page, the toolchain's trees and the Workbench's stories.
 */
export function configValues<V, D = WidgetConfigField["default"]>(fields: readonly { key: string; default?: D; secret?: boolean }[] | null | undefined, set: Readonly<Record<string, V>> | null | undefined): Record<string, V | NonNullable<D>> {
  const out: Record<string, V | NonNullable<D>> = {};
  for (const f of fields ?? []) {
    if (f.secret) continue;
    const v = set?.[f.key];
    if (v !== undefined && v !== null) out[f.key] = v;
    else if (f.default !== undefined && f.default !== null) out[f.key] = f.default;
  }
  return out;
}

/** The window kind of a package's widget: "pkg:<package>/<widget>". */
export const packageKind = (name: string, widget: string): string => `pkg:${name}/${widget}`;

/** The package and widget of a "pkg:<package>/<widget>" kind, else null. */
export function parsePackageKind(kind: string): { name: string; widget: string } | null {
  const m = /^pkg:([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9-]*)$/.exec(kind);
  return m ? { name: m[1]!, widget: m[2]! } : null;
}
