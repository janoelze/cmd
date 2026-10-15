// The elements of the widget API (docs/56, "The view"): the one place an element's props,
// events, children and docs are written. Everything else is read or generated from
// API_ELEMENTS: the renderer's sanitiser and element table, @cmd/widget-api's elements.gen.ts
// (`pnpm widget-api:gen`), its README reference and the website (`pnpm widget-api:docs`),
// the testing tree's gestures and titles. Split from widget-tree.ts, which re-exports all
// of it, so `@cmd/protocol/widget-tree` is still the whole wire contract. The vocabulary (enums,
// prop types, gestures) is widget-spec.ts; each minor that adds elements has a file
// (widget-elements-1.2.ts; 1.3's by feature, widget-elements-1.3-layout.ts and widget-elements-1.3-display.ts), merged into API_ELEMENTS here.

import type { HandlerRef, WireValue } from "./widget-tree.ts";
import { ALIGN, BREAKS, DISABLED, LIGHTS, SPACE, SYMBOL, TEXT_SIZES, TIP, TONES, TOOLBAR_ITEM, chosen, none, press, typed, type ActionOf, type ApiElementSpec, type MenuEntryOf, type OptionOf, type ViewStateOf } from "./widget-spec.ts";
import { ELEMENTS_1_2 } from "./widget-elements-1.2.ts";
import { ELEMENTS_1_3_LAYOUT, STACK_1_3, TEXT_1_3 } from "./widget-elements-1.3-layout.ts";
import { ELEMENTS_1_3_DISPLAY, REVEAL_1_3, SEARCH_EVENTS_1_3, SPARKLINE_1_3, STAT_1_3, WINDOW_1_3 } from "./widget-elements-1.3-display.ts";

export { SPACE, TONES, LIGHTS, TEXT_SIZES, ALIGN, BREAKS, UNITS, API_ENUMS, TOOLBAR_ITEM, isShape } from "./widget-spec.ts";
export type { MenuEntryOf, ActionOf, ViewStateOf, OptionOf, WireMenuEntry, ApiFieldType, ApiFieldSpec, ApiShape, ApiPropType, ApiPropSpec, ApiGesture, ApiEventSpec, ApiElementSpec } from "./widget-spec.ts";

/** API 1.0's elements, with each one's props, events, children and docs. */
const ELEMENTS_1_0 = {
  Window: {
    doc: "The widget's window, around everything: the title bar (icon and name from the manifest), its status line and menus. Optional; a widget without one gets the bare title bar.",
    props: {
      status: { type: "string", nullable: true, doc: 'The title bar\'s status line ("2 waiting for you · 1 working"); null for none.' },
      menu: { type: "menu", doc: "The title menu (a scope switch: This Workspace / All Workspaces)." },
      actions: { type: "menu", doc: "Entries added to the window's context menu." },
      ...WINDOW_1_3,
    },
    events: {},
    children: "elements",
    childrenDoc: "The window's content: a View.",
  },
  View: {
    doc: "A window's content frame: toolbar, scrolling body, and the states that replace it.",
    props: {
      inset: { type: "boolean", doc: "Pads the body by the window inset." },
      scroll: { type: "boolean", doc: "The body scrolls (default true)." },
      state: { type: "viewState", nullable: true, doc: "Shown instead of the body: empty, loading, no results, error." },
    },
    events: {},
    children: "elements",
    childrenDoc: "The body; a WindowToolbar among them becomes the view's toolbar, a StatusLine its footer.",
  },
  WindowToolbar: {
    doc: "A view's toolbar: buttons, fields, segmented controls. Items that don't fit move to a ⋯ menu.",
    props: {
      label: { type: "string", shows: "title", doc: 'Its accessible name ("Filter agents").' },
      bottom: { type: "boolean", doc: "Under the content instead of over it." },
    },
    events: {},
    children: "elements",
    childrenDoc: "Its items: ToolbarButton, ToolbarField, ToolbarSearchField, ToolbarSegmented, ToolbarMenu, ToolbarText, ToolbarSpacer.",
  },
  ToolbarButton: {
    doc: "A toolbar button.",
    props: {
      label: { type: "string", required: true, shows: "title", doc: "The tooltip and accessible name; shown beside the icon with `showLabel`." },
      icon: { type: "string", doc: "An SF Symbol name; without one it is a text button." },
      showLabel: { type: "boolean", doc: "Shows the label beside the icon while there is room." },
      pressed: { type: "boolean", doc: "On (a toggle)." },
      disabled: DISABLED,
      tone: { type: ["accent", "danger", "needs"], doc: "A tone for its icon (a count of failures, a change)." },
      badge: { type: "text", doc: "A count after the label." },
      tip: { type: "string", doc: "A tooltip other than the label." },
      ...TOOLBAR_ITEM,
    },
    events: { onClick: press("Pressed.") },
    children: "none",
  },
  ToolbarField: {
    doc: "A text field in a toolbar.",
    props: {
      value: { type: "string", required: true, shows: "words", doc: "The text in it." },
      placeholder: { type: "string", doc: "Shown while it is empty; also its accessible name." },
      icon: { type: "string", doc: "An SF Symbol name before the text." },
      ...TOOLBAR_ITEM,
    },
    events: { onChange: typed("The text as typed (debounced by the app, which keeps the caret)."), onSubmit: { gesture: "submit", doc: "Return pressed, with the text." } },
    children: "none",
  },
  ToolbarSearchField: {
    doc: "A filter field: a magnifying glass, a count, a clear button.",
    props: {
      value: { type: "string", required: true, shows: "words", doc: "The filter text." },
      placeholder: { type: "string", doc: 'Shown while it is empty ("Filter agents").' },
      count: { type: "text", doc: 'What matched ("3 of 12").' },
      ...TOOLBAR_ITEM,
    },
    events: { onChange: typed('The text as typed (debounced by the app); "" when cleared.'), ...SEARCH_EVENTS_1_3 },
    children: "none",
  },
  ToolbarSegmented: {
    doc: "A choice of a few, side by side (a popup when narrow).",
    props: {
      value: { type: "option", required: true, shows: "words", doc: "The chosen option's value." },
      options: { type: "options", required: true, doc: "The options, in order: a value, a label, an optional SF Symbol." },
      label: { type: "string", required: true, shows: "title", doc: "Its accessible name." },
      ...TOOLBAR_ITEM,
    },
    events: { onChange: chosen("An option was chosen.") },
    children: "none",
  },
  ToolbarMenu: {
    doc: "A toolbar button that opens a menu.",
    props: {
      label: { type: "string", required: true, shows: "title", doc: "The tooltip and accessible name." },
      icon: { type: "string", doc: SYMBOL },
      menu: { type: "menu", required: true, doc: "The menu it opens." },
      disabled: DISABLED,
      ...TOOLBAR_ITEM,
    },
    events: {},
    children: "none",
  },
  ToolbarText: { doc: "A little text in a toolbar (a count, a path).", props: { ...TOOLBAR_ITEM }, events: {}, children: "text", childrenDoc: "The text." },
  ToolbarSpacer: { doc: "Pushes what follows to the toolbar's end.", ...none },
  Stack: {
    doc: "Children in a column, `gap` apart.",
    props: {
      gap: { type: SPACE, doc: "Space between children, in steps of the scale (default 2)." },
      pad: { type: [...SPACE, "inset"], doc: "Padding on every side, or the window inset." },
      padY: { type: SPACE, doc: "Top and bottom padding instead of `pad`'s there." },
      align: { type: ALIGN, doc: "How children line up across the column." },
      grow: { type: "boolean", doc: "Takes the room left." },
      ...STACK_1_3,
    },
    events: {},
    children: "elements",
    childrenDoc: "What it stacks.",
  },
  Inline: {
    doc: "Children in a row, `gap` apart.",
    props: {
      gap: { type: SPACE, doc: "Space between children, in steps of the scale (default 1.5)." },
      align: { type: ALIGN, doc: "How children line up across the row (default center)." },
      justify: { type: ["start", "between", "end"], doc: "Where the children sit along the row." },
      wrap: { type: "boolean", doc: "Wraps onto more lines when the row is full." },
      grow: { type: "boolean", doc: "Takes the room left." },
    },
    events: {},
    children: "elements",
    childrenDoc: "What it lines up.",
  },
  Tiles: {
    doc: "A grid of equal tiles (stats, cards).",
    props: {
      min: { type: [96, 120, 160, 200, 240, 320], doc: "A tile's least width in px: as many columns as fit." },
      gap: { type: SPACE, doc: "Space between tiles, in steps of the scale (default 2)." },
    },
    events: {},
    children: "elements",
    childrenDoc: "The tiles.",
  },
  Hide: {
    doc: "Drops what doesn't fit the window's size class.",
    props: {
      below: { type: BREAKS, doc: "Hidden while the window is narrower than this size class." },
      above: { type: BREAKS, doc: "Hidden while it is wider." },
    },
    events: {},
    children: "elements",
    childrenDoc: "What it hides.",
  },
  List: { doc: "Rows and sections; virtualised by the app, keyed rows keep their place.", props: {}, events: {}, children: "elements", childrenDoc: "ListSections and ListRows." },
  ListSection: {
    doc: "A heading and its rows.",
    props: {
      title: { type: "string", required: true, shows: "title", doc: "The heading." },
      count: { type: "number", doc: "A count after the title." },
      open: { type: "boolean", doc: "false: folded, only the heading." },
      tone: { type: ["needs", "danger"], doc: 'Colours the heading: "needs" for what waits for the person.' },
    },
    events: { onToggle: press("The heading was pressed (fold or unfold it).") },
    children: "elements",
    childrenDoc: "Its rows.",
  },
  ListRow: {
    doc: "A row.",
    props: {
      selected: { type: "boolean", doc: "Shown as the selected row." },
      dim: { type: "boolean", doc: "Faded." },
      depth: { type: "number", doc: "Indent, for a row under another (a subagent)." },
      tip: TIP,
      menu: { type: "menu", doc: "Its context menu." },
      ...REVEAL_1_3,
    },
    events: { onClick: press("Pressed (the row's main action: open, select)."), onDoubleClick: { gesture: "doubleClick", doc: "Double-clicked." } },
    children: "elements",
    childrenDoc: "Its parts in order: ListRowIcon, ListRowContent, ListRowEnd.",
  },
  ListRowIcon: {
    doc: "A row's icon, or its status light.",
    props: {
      icon: { type: "string", required: true, doc: SYMBOL },
      light: { type: LIGHTS, doc: "A status light that takes the icon's place (an agent's state)." },
      tone: { type: [...LIGHTS, "dim"], doc: "Colours the icon." },
    },
    events: {},
    children: "none",
  },
  ListRowContent: {
    doc: "A row's text.",
    props: {
      title: { type: "text", required: true, shows: "title", doc: "The first line." },
      place: { type: "text", shows: "words", doc: "Dim, after the title (one-line rows); gives way first." },
      detail: { type: "text", nullable: true, shows: "words", doc: "A second line under the title." },
      tone: { type: ["needs", "danger"], doc: "Colours the detail line." },
      mono: { type: "boolean", doc: "The title in the monospaced font (a path, a command)." },
    },
    events: {},
    children: "none",
  },
  ListRowEnd: { doc: "A row's right end: a chip, an age, a badge.", props: {}, events: {}, children: "any", childrenDoc: "What sits at the end: a Chip, a Badge, Text." },
  Chip: {
    doc: "A small pill of text (an age, a branch).",
    props: {
      hue: { type: "number", doc: "A hue (0–360) for its tint; the neutral one without." },
      tip: TIP,
    },
    events: {},
    children: "text",
    childrenDoc: "Its text.",
  },
  Stat: {
    doc: "A number with its label.",
    props: {
      label: { type: "string", required: true, shows: "title", doc: "What it counts." },
      value: { type: "text", required: true, shows: "words", doc: "The number, formatted (`fmt.num`)." },
      unit: { type: "string", doc: 'After the value ("ms", "%").' },
      delta: { type: "text", doc: 'A change beside it ("+12%").' },
      deltaTone: { type: TONES, doc: 'The change\'s tone: "success" for better, "danger" for worse.' },
      ...STAT_1_3,
    },
    events: { onSelect: press("Pressed (show what it counts).") },
    children: "elements",
    childrenDoc: "Drawn under the value, as wide as the tile: a Sparkline.",
    childrenSince: "1.3",
  },
  Sparkline: {
    doc: "A small line of recent values.",
    props: {
      values: { type: "numbers", required: true, doc: "The values, oldest first; null is a gap." },
      height: { type: "number", doc: "In px (default 20)." },
      area: { type: "boolean", doc: "Fills under the line (default true)." },
      color: { type: ["current", "neutral"], doc: 'The accent ("current") or neutral instead of the series colour.' },
      ...SPARKLINE_1_3,
    },
    events: {},
    children: "none",
  },
  Text: {
    doc: "Words.",
    props: {
      tone: { type: ["dim", ...TONES], doc: '"dim" for secondary words, or a tone.' },
      size: { type: TEXT_SIZES, doc: "A step of the type scale." },
      mono: { type: "boolean", doc: "The monospaced font." },
      strong: { type: "boolean", doc: "Bold." },
      truncate: { type: "boolean", doc: "One line, cut with an ellipsis." },
      select: { type: "boolean", doc: "Selectable, for a value to copy." },
      balance: { type: "boolean", doc: "Balanced line breaks (a heading)." },
      ...TEXT_1_3,
    },
    events: {},
    children: "text",
    childrenDoc: "The words.",
  },
  Badge: {
    doc: 'A label in a tone ("failed", "3 new").',
    props: {
      tone: { type: TONES, doc: "Its colour (default neutral)." },
      size: { type: ["sm", "md"], doc: '"sm" in a row, "md" elsewhere.' },
      solid: { type: "boolean", doc: "Filled, for what must stand out." },
      tip: TIP,
    },
    events: {},
    children: "text",
    childrenDoc: "Its text.",
  },
  StatusDot: {
    doc: "A small status light.",
    props: {
      state: { type: LIGHTS, doc: "An agent's state or a tone." },
      size: { type: ["sm", "md"], doc: '"sm" or "md".' },
      label: { type: "string", shows: "title", doc: "Its accessible name." },
    },
    events: {},
    children: "none",
  },
  Button: {
    doc: "A button.",
    props: {
      variant: { type: ["default", "primary", "danger", "ghost"], doc: '"primary" for the one main action, "danger" for a destructive one, "ghost" for a quiet one.' },
      size: { type: ["sm", "md", "lg"], doc: '"sm", "md" (default) or "lg".' },
      icon: { type: "string", doc: "An SF Symbol name before the label." },
      pressed: { type: "boolean", doc: "Shown as pressed (a toggle that is on)." },
      busy: { type: "boolean", doc: "A spinner, and disabled." },
      disabled: DISABLED,
    },
    events: { onClick: press("Pressed.") },
    children: "text",
    childrenDoc: "Its label.",
  },
  EmptyState: {
    doc: "What a view shows when it has nothing: what's missing and how to get some.",
    props: {
      icon: { type: "string", doc: SYMBOL },
      title: { type: "string", shows: "title", doc: 'What\'s missing ("No agents").' },
      text: { type: "string", shows: "words", doc: 'How to get some ("Start one with ⌥⌘N.").' },
      action: { type: "action", doc: "One button: the way on." },
      compact: { type: "boolean", doc: "Smaller, for a narrow pane." },
    },
    events: {},
    children: "none",
  },
  Callout: {
    doc: "A note in a box: a warning, an error, a tip.",
    props: {
      tone: { type: TONES, doc: 'Its colour and default icon: "warning", "danger" for an error, "accent" for a tip.' },
      title: { type: "string", shows: "title", doc: "The first line, bold." },
      icon: { type: "string", doc: "An SF Symbol name; by default the tone's." },
      compact: { type: "boolean", doc: "One small line." },
      banner: { type: "boolean", doc: "Full width along the view's top edge." },
    },
    events: { onDismiss: { gesture: "dismiss", doc: "Shows a close button." } },
    children: "any",
    childrenDoc: "What it says; Buttons in it are its actions.",
  },
  Progress: {
    doc: "A progress bar.",
    props: {
      value: { type: "number", shows: "words", doc: "0–1; without one it is indeterminate." },
      tone: { type: TONES, doc: "Its colour (default accent)." },
      label: { type: "string", shows: "title", doc: "Its accessible name." },
    },
    events: {},
    children: "none",
  },
} as const satisfies Record<string, ApiElementSpec>;

/** API 1's elements (1.0's, then each minor's): the allow-list the renderer enforces. */
export const API_ELEMENTS = { ...ELEMENTS_1_0, ...ELEMENTS_1_2, ...ELEMENTS_1_3_LAYOUT, ...ELEMENTS_1_3_DISPLAY } as const satisfies Record<string, ApiElementSpec>;

export type ApiElement = keyof typeof API_ELEMENTS;
export const API_ELEMENT_NAMES = Object.keys(API_ELEMENTS) as ApiElement[];

/** An element's spec, as API_ELEMENTS has it (literal types). */
export type ApiElementOf<E extends ApiElement> = (typeof API_ELEMENTS)[E];

/** A prop type's values on the wire (null aside). */
export type WireTypeOf<T, H = HandlerRef> = T extends "string" | "option"
  ? string
  : T extends "text"
    ? string | number
    : T extends "number"
      ? number
      : T extends "boolean"
        ? boolean
        : T extends "numbers"
          ? (number | null)[]
          : T extends "menu"
            ? MenuEntryOf<H>[]
            : T extends "action"
              ? ActionOf<H>
              : T extends "viewState"
                ? ViewStateOf<H>
                : T extends "options"
                  ? OptionOf[]
                  : T extends "strings"
                    ? string[]
                    : T extends "matrix"
                      ? number[][]
                      : T extends "cells"
                        ? (string | number | null)[]
                        : T extends "value"
                          ? WireValue
                        : T extends { list: infer F }
                          ? FieldsOf<F>[]
                          : T extends { record: infer F }
                            ? FieldsOf<F>
                            : T extends readonly (infer V)[]
                              ? V
                              : never;

type RequiredKeys<P> = { [K in keyof P]: P[K] extends { required: true } ? K : never }[keyof P];
type PropValue<S, H> = S extends { type: infer T } ? WireTypeOf<T, H> | (S extends { nullable: true } ? null : never) : never;
/** A record's fields as values (1.2: a series, a column, a row). */
export type FieldsOf<F> = { -readonly [K in Exclude<keyof F, RequiredKeys<F>>]?: PropValue<F[K], never> } & { -readonly [K in RequiredKeys<F>]: PropValue<F[K], never> };
/** An element's props (not its events or children) as values, with handlers `H` inside menus and actions. */
export type SpecPropsOf<E extends ApiElement, H = HandlerRef> = { -readonly [K in Exclude<keyof ApiElementOf<E>["props"], RequiredKeys<ApiElementOf<E>["props"]>>]?: PropValue<ApiElementOf<E>["props"][K], H> } & {
  -readonly [K in RequiredKeys<ApiElementOf<E>["props"]>]: PropValue<ApiElementOf<E>["props"][K], H>;
};
/** An element's event names. */
export type EventsOf<E extends ApiElement> = keyof ApiElementOf<E>["events"] & string;
/** The value an element's event carries: the spec's `value` (with null when nullable), a string for "change" and "submit", none else. */
export type EventValueOf<S> = S extends { value: infer V } ? WireTypeOf<V> | (S extends { nullable: true } ? null : never) : S extends { gesture: "change" | "submit" } ? string : undefined;

export * from "./widget-values.ts";
export { BOX_STEP, BOX_EVERY_MS, WINDOW_BAR_H, roundBox, sizeClassOf, sizeEnv, type ApiBox } from "./widget-elements-1.3-layout.ts";
