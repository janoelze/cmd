// How the widget API's elements are written down (docs/56, "The view"): the enums props take,
// the shapes inside props, and what a prop, an event and an element say about themselves. The
// elements are in widget-elements.ts (API 1.0 and 1.1) and in a file per minor that added some
// (widget-elements-1.2.ts); widget-elements.ts puts them together as API_ELEMENTS. Split from
// widget-elements.ts so each minor's elements can be a file of their own.

import type { ApiLight, ApiTone, HandlerRef } from "./widget-tree.ts";
import type { StatUnit } from "./stats.ts";
import type { VIEW_STATE_KINDS } from "./widget-values.ts";

// ── the enums ───────────────────────────────────────────

/** Steps of the spacing scale (`2` is 8 px), and 0. */
export const SPACE = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12] as const;
/** The tones: what colours are named by. */
export const TONES = ["neutral", "accent", "success", "warning", "danger"] as const;
/** A status light: an agent's state, or a tone. */
export const LIGHTS = ["needs", "unseen", "working", "done", "idle", "off", ...TONES] as const;
/** The type scale. */
export const TEXT_SIZES = ["2xs", "xs", "sm", "md", "base", "lg", "xl", "display"] as const;
/** How children line up across a Stack or an Inline. */
export const ALIGN = ["start", "center", "end", "stretch", "baseline"] as const;
/** The window's size classes (Hide). */
export const BREAKS = ["narrow", "regular"] as const;
/** How a chart's values read (1.2): the stats' units (protocol format.ts formats them). */
export const UNITS = ["count", "ms", "bytes", "tokens", "percent"] as const;

/**
 * The enums @cmd/widget-api names as types (elements.gen.ts is generated with them): a prop
 * whose values contain one of these runs shows its name (`Space | "inset"`, `"dim" | Tone`).
 * `exported: false` is named in the d.ts but not exported. `since`: the minor it came in.
 */
export const API_ENUMS = {
  Space: { values: SPACE, doc: "A step of the spacing scale (`2` is 8 px), or 0.", exported: true, since: "1.0" },
  Tone: { values: TONES, doc: "Tones, never colours.", exported: true, since: "1.0" },
  Light: { values: LIGHTS, doc: "A status light: an agent's state, or a tone.", exported: true, since: "1.0" },
  TextSize: { values: TEXT_SIZES, doc: "The type scale.", exported: true, since: "1.0" },
  Align: { values: ALIGN, doc: "How children line up across a Stack or an Inline.", exported: false, since: "1.0" },
  Unit: { values: UNITS, doc: "How a chart's values read: counts, `ms` as durations (3h 12m), bytes, tokens, percent (of 100).", exported: true, since: "1.2" },
} as const;

// widget-tree.ts spells ApiTone and ApiLight out (Magic's prompt pastes them as declared), and stats.ts the units: held to the consts here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameTone: Same<ApiTone, (typeof TONES)[number]> = true;
const sameLight: Same<ApiLight, (typeof LIGHTS)[number]> = true;
const sameUnit: Same<StatUnit, (typeof UNITS)[number]> = true;
void sameTone, sameLight, sameUnit;

// ── the shapes inside props ─────────────────────────────

/** A menu entry in a prop (`Window menu`, `ListRow menu`): data, with `run` a handler `H` (a function in the widget, a HandlerRef on the wire). */
export type MenuEntryOf<H> = { label: string; run?: H; checked?: boolean; disabled?: boolean; submenu?: MenuEntryOf<H>[] } | { separator: true };
/** A button as data: an empty state's or a view state's one way on. */
export interface ActionOf<H> {
  label: string;
  run: H;
}
/** What replaces a View's body: empty (the default), loading, no results, error; one line and one action. */
export interface ViewStateOf<H> {
  kind?: (typeof VIEW_STATE_KINDS)[number];
  /** An SF Symbol name. */
  icon?: string;
  title?: string;
  text?: string;
  action?: ActionOf<H>;
}
/** A ToolbarSegmented's option: a value, a label, an optional SF Symbol. */
export interface OptionOf<T extends string = string> {
  value: T;
  label: string;
  icon?: string;
}

/** A menu entry on the wire. */
export type WireMenuEntry = MenuEntryOf<HandlerRef>;

// ── the spec ────────────────────────────────────────────

/**
 * A field of the records a prop holds (1.2: a chart's series, a table's columns and rows):
 * plain values only. "cells" is a (string | number | null)[] (a table row's values, in the
 * columns' order).
 */
export type ApiFieldType = "string" | "text" | "number" | "boolean" | "numbers" | "cells" | readonly (string | number)[];

export interface ApiFieldSpec {
  type: ApiFieldType;
  required?: boolean;
  nullable?: boolean;
  /** Its JSDoc. */
  doc: string;
}

/** Records in a prop (1.2): a list of them or one, each with these fields; `name` is the type @cmd/widget-api calls it, `doc` its JSDoc. */
export type ApiShape = { list: Readonly<Record<string, ApiFieldSpec>>; name: string; doc: string } | { record: Readonly<Record<string, ApiFieldSpec>>; name: string; doc: string };

/**
 * A prop's type on the wire. A string or number array is an enum. "text" is a string or a
 * number; "numbers" a (number | null)[] (null is a gap); "menu" a MenuEntryOf[]; "action"
 * an ActionOf; "viewState" a ViewStateOf; "options" OptionOf[]; "option" one option's value
 * (a string; the element is generic over it in @cmd/widget-api). 1.2: "strings" a string[];
 * "matrix" a number[][]; an ApiShape records of named fields; "value" any plain data (strings,
 * numbers, booleans, null, lists and records of them, no handlers; at most VALUE_MAX_BYTES as
 * JSON), what a Frame passes to its page and back.
 */
export type ApiPropType = "string" | "text" | "number" | "boolean" | "numbers" | "menu" | "action" | "viewState" | "options" | "option" | "strings" | "matrix" | "cells" | "value" | ApiShape | readonly (string | number)[];

export interface ApiPropSpec {
  type: ApiPropType;
  /** The element needs it (the d.ts says so; the renderer draws it empty without). */
  required?: boolean;
  /** null is a value of its own ("none"); any prop may be null on the wire, which unsets it. */
  nullable?: boolean;
  /** Its JSDoc. */
  doc: string;
  /** What the testing tree reads as words: the element's title (`find(type, title)`), or more of its words (`text()`). */
  shows?: "title" | "words";
}

/**
 * What a person does to fire an event (the testing tree's press, doubleClick, change, submit,
 * pick, message). "change", "submit" and "pick" carry a value; "pick" is a press on one of several
 * things (a table's row, a chart's bucket, a ribbon's bar) and says which (1.2); "message" is a
 * Frame's page sending a value (`cmd.post`), which is no press (1.2).
 */
export type ApiGesture = "press" | "doubleClick" | "change" | "submit" | "dismiss" | "pick" | "message";

export interface ApiEventSpec {
  gesture: ApiGesture;
  /** Its JSDoc. */
  doc: string;
  /** The value it carries (1.2; "change" and "submit" carry a string without one). */
  value?: ApiPropType;
  /** The value may be null (a sort turned off). */
  nullable?: boolean;
  /** Typing into a field: not a press, so it can't start an act (the core's press model). */
  typing?: true;
}

export interface ApiElementSpec {
  /** Its JSDoc. */
  doc?: string;
  /** The API version it came in. */
  since?: string;
  props: Record<string, ApiPropSpec>;
  /** The handler props it takes ("onClick"); a handler anywhere else is dropped. */
  events: Record<string, ApiEventSpec>;
  /** What it holds: nothing, strings only, elements only, or both. */
  children: "none" | "text" | "elements" | "any";
  /** The children prop's JSDoc. */
  childrenDoc?: string;
}

/** The most a "value" prop or event may hold, as JSON (bytes). */
export const VALUE_MAX_BYTES = 256 * 1024;

/** Whether a prop type is records (an ApiShape). */
export const isShape = (t: ApiPropType): t is ApiShape => typeof t === "object" && !Array.isArray(t) && ("list" in t || "record" in t);

// ── what the element files share ────────────────────────

export const none = { props: {}, events: {}, children: "none" } as const;
export const press = (doc: string) => ({ gesture: "press", doc }) as const;
export const typed = (doc: string) => ({ gesture: "change", doc, typing: true }) as const;
export const chosen = (doc: string) => ({ gesture: "change", doc }) as const;
export const pick = <V extends ApiPropType>(doc: string, value: V) => ({ gesture: "pick", doc, value }) as const;
export const SYMBOL = "An SF Symbol name.";
export const TIP = { type: "string", doc: "A tooltip." } as const;
export const DISABLED = { type: "boolean", doc: "Greyed out, not pressable." } as const;
/** What every toolbar item takes (the d.ts's ToolbarItem): its place in the ⋯ menu when room runs out, faded until hovered. */
export const TOOLBAR_ITEM = {
  priority: { type: "number", doc: "Moves to the ⋯ menu when there is no room, lowest first; without one it stays." },
  secondary: { type: "boolean", doc: "Faded until the window is hovered or selected." },
} as const;
