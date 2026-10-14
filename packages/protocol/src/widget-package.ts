// Widget packages (docs/56-widgets-v3.md, "A widget is a package"): the API majors this
// cmd serves, what a package may ask for, and how its windows are named. The parser is
// the core's (widgets/package.ts); this is what clients share with it.

/** The widget API majors this cmd runs (`cmd.api` in a package.json). */
export const SUPPORTED_API = { min: 1, max: 1 } as const;

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
}

export const PERMISSION_KEYS = ["net", "run", "read", "workspace", "events", "act", "ai"] as const satisfies readonly (keyof WidgetPermissions)[];

export const noPermissions = (): WidgetPermissions => ({ net: [], run: [], read: [], workspace: [], events: [], act: [], ai: [] });

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

/** The window kind of a package's widget: "pkg:<package>/<widget>". */
export const packageKind = (name: string, widget: string): string => `pkg:${name}/${widget}`;

/** The package and widget of a "pkg:<package>/<widget>" kind, else null. */
export function parsePackageKind(kind: string): { name: string; widget: string } | null {
  const m = /^pkg:([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9-]*)$/.exec(kind);
  return m ? { name: m[1]!, widget: m[2]! } : null;
}
