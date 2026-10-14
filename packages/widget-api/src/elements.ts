// The elements of API 1 (docs/56, "The view"): what a widget's view is made of. Each is
// the API's own tag, not a kit component: the reconciler sends `{ type: "ListRow", props }`
// and the app draws it with whatever kit component the element table maps it to today.
// Props are data (strings, numbers, tones, steps of the spacing scale); handlers are
// functions the reconciler turns into ids. There is no className, style or ref: a look
// is a prop, or a kit change. The allow-list with each element's props is the
// protocol's API_ELEMENTS; test/elements.test.ts holds these types to it.

import type { ReactElement, ReactNode } from "react";
import type { ApiElement, ApiLight, ApiTone } from "@cmd/protocol/widget-tree";

/** An element of the API: JSX makes a host element of its tag. */
type El<P> = (props: P & { key?: string | number }) => ReactElement;
const el = <P>(name: ApiElement) => name as unknown as El<P>;

/** A step of the spacing scale (`2` is 8 px), or 0. @since 1.0 */
export type Space = 0 | 0.5 | 1 | 1.5 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12;
/** Tones, never colours. @since 1.0 */
export type Tone = ApiTone;
/** A status light: an agent's state, or a tone. @since 1.0 */
export type Light = ApiLight;
/** The type scale. @since 1.0 */
export type TextSize = "2xs" | "xs" | "sm" | "md" | "base" | "lg" | "xl" | "display";

/** A context or title menu's entry: data, with `run` called when chosen. @since 1.0 */
export type MenuEntry = { label: string; run?: () => void; checked?: boolean; disabled?: boolean; submenu?: MenuEntry[] } | { separator: true };
/** A button as data: an empty state's or a view state's one way on. @since 1.0 */
export interface Action {
  label: string;
  run: () => void;
}
/** What replaces a View's body: empty (the default), loading, no results, error; one line and one action. @since 1.0 */
export interface ViewState {
  kind?: "empty" | "loading" | "noResults" | "error";
  /** An SF Symbol name. */
  icon?: string;
  title?: string;
  text?: string;
  action?: Action;
}

// ── window ──────────────────────────────────────────────

/** @since 1.0 */
export interface WindowProps {
  /** The title bar's status line ("2 waiting for you · 1 working"); null for none. */
  status?: string | null;
  /** The title menu (a scope switch: This Workspace / All Workspaces). */
  menu?: MenuEntry[];
  /** Entries added to the window's context menu. */
  actions?: MenuEntry[];
  children?: ReactNode;
}
/**
 * The widget's window, around everything: the title bar (icon and name from the
 * manifest), its status line and menus. Optional; a widget without one gets the bare title bar.
 * @since 1.0
 */
export const Window = el<WindowProps>("Window");

/** @since 1.0 */
export interface ViewProps {
  /** Pads the body by the window inset. */
  inset?: boolean;
  /** The body scrolls (default true). */
  scroll?: boolean;
  /** Shown instead of the body: empty, loading, no results, error. */
  state?: ViewState | null;
  /** The body; a WindowToolbar among them becomes the view's toolbar. */
  children?: ReactNode;
}
/**
 * A window's content frame: toolbar, scrolling body, and the states that replace it.
 * @since 1.0
 */
export const View = el<ViewProps>("View");

/** @since 1.0 */
export interface WindowToolbarProps {
  /** Its accessible name ("Filter agents"). */
  label?: string;
  /** Under the content instead of over it. */
  bottom?: boolean;
  children?: ReactNode;
}
/**
 * A view's toolbar: buttons, fields, segmented controls. Items that don't fit move to a ⋯ menu.
 * @since 1.0
 */
export const WindowToolbar = el<WindowToolbarProps>("WindowToolbar");

/** What every toolbar item takes. @since 1.0 */
interface ToolbarItem {
  /** Moves to the ⋯ menu when there is no room, lowest first; without one it stays. */
  priority?: number;
  /** Faded until the window is hovered or selected. */
  secondary?: boolean;
}

/** @since 1.0 */
export interface ToolbarButtonProps extends ToolbarItem {
  /** The tooltip and accessible name; shown beside the icon with `showLabel`. */
  label: string;
  /** An SF Symbol name; without one it is a text button. */
  icon?: string;
  showLabel?: boolean;
  /** On (a toggle). */
  pressed?: boolean;
  disabled?: boolean;
  tone?: "accent" | "danger" | "needs";
  /** A count after the label. */
  badge?: string | number;
  /** A tooltip other than the label. */
  tip?: string;
  onClick?: () => void;
}
/** A toolbar button. @since 1.0 */
export const ToolbarButton = el<ToolbarButtonProps>("ToolbarButton");

/** @since 1.0 */
export interface ToolbarFieldProps extends ToolbarItem {
  value: string;
  placeholder?: string;
  /** An SF Symbol name before the text. */
  icon?: string;
  /** The text as typed (debounced by the app, which keeps the caret). */
  onChange?: (value: string) => void;
  /** Return pressed, with the text. */
  onSubmit?: (value: string) => void;
}
/** A text field in a toolbar. @since 1.0 */
export const ToolbarField = el<ToolbarFieldProps>("ToolbarField");

/** @since 1.0 */
export interface ToolbarSearchFieldProps extends ToolbarItem {
  value: string;
  placeholder?: string;
  /** What matched ("3 of 12"). */
  count?: string | number;
  onChange?: (value: string) => void;
}
/** A filter field: a magnifying glass, a count, a clear button. @since 1.0 */
export const ToolbarSearchField = el<ToolbarSearchFieldProps>("ToolbarSearchField");

/** @since 1.0 */
export interface ToolbarSegmentedProps<T extends string = string> extends ToolbarItem {
  value: T;
  options: { value: T; label: string; icon?: string }[];
  /** Its accessible name. */
  label: string;
  onChange?: (value: T) => void;
}
/** A choice of a few, side by side (a popup when narrow). @since 1.0 */
export const ToolbarSegmented = el<ToolbarSegmentedProps>("ToolbarSegmented");

/** @since 1.0 */
export interface ToolbarMenuProps extends ToolbarItem {
  label: string;
  icon?: string;
  menu: MenuEntry[];
  disabled?: boolean;
}
/** A toolbar button that opens a menu. @since 1.0 */
export const ToolbarMenu = el<ToolbarMenuProps>("ToolbarMenu");

/** @since 1.0 */
export interface ToolbarTextProps extends ToolbarItem {
  children?: ReactNode;
}
/** A little text in a toolbar (a count, a path). @since 1.0 */
export const ToolbarText = el<ToolbarTextProps>("ToolbarText");

/** Pushes what follows to the toolbar's end. @since 1.0 */
export const ToolbarSpacer = el<Record<string, never>>("ToolbarSpacer");

// ── layout ──────────────────────────────────────────────

type Align = "start" | "center" | "end" | "stretch" | "baseline";

/** @since 1.0 */
export interface StackProps {
  gap?: Space;
  /** Padding on every side, or the window inset. */
  pad?: Space | "inset";
  /** Top and bottom padding instead of `pad`'s there. */
  padY?: Space;
  align?: Align;
  /** Takes the room left. */
  grow?: boolean;
  children?: ReactNode;
}
/** Children in a column, `gap` apart. @since 1.0 */
export const Stack = el<StackProps>("Stack");

/** @since 1.0 */
export interface InlineProps {
  gap?: Space;
  align?: Align;
  justify?: "start" | "between" | "end";
  wrap?: boolean;
  grow?: boolean;
  children?: ReactNode;
}
/** Children in a row, `gap` apart. @since 1.0 */
export const Inline = el<InlineProps>("Inline");

/** @since 1.0 */
export interface TilesProps {
  /** A tile's least width in px: as many columns as fit. */
  min?: 96 | 120 | 160 | 200 | 240 | 320;
  gap?: Space;
  children?: ReactNode;
}
/** A grid of equal tiles (stats, cards). @since 1.0 */
export const Tiles = el<TilesProps>("Tiles");

/** @since 1.0 */
export interface HideProps {
  /** Hidden while the window is narrower than this size class. */
  below?: "narrow" | "regular";
  /** Hidden while it is wider. */
  above?: "narrow" | "regular";
  children?: ReactNode;
}
/** Drops what doesn't fit the window's size class. @since 1.0 */
export const Hide = el<HideProps>("Hide");

// ── lists ───────────────────────────────────────────────

/** @since 1.0 */
export interface ListProps {
  children?: ReactNode;
}
/** Rows and sections; virtualised by the app, keyed rows keep their place. @since 1.0 */
export const List = el<ListProps>("List");

/** @since 1.0 */
export interface ListSectionProps {
  title: string;
  /** A count after the title. */
  count?: number;
  /** false: folded, only the heading. */
  open?: boolean;
  tone?: "needs" | "danger";
  /** The heading was pressed (fold or unfold it). */
  onToggle?: () => void;
  children?: ReactNode;
}
/** A heading and its rows. @since 1.0 */
export const ListSection = el<ListSectionProps>("ListSection");

/** @since 1.0 */
export interface ListRowProps {
  selected?: boolean;
  /** Faded. */
  dim?: boolean;
  /** Indent, for a row under another (a subagent). */
  depth?: number;
  tip?: string;
  /** Its context menu. */
  menu?: MenuEntry[];
  onClick?: () => void;
  onDoubleClick?: () => void;
  /** Its parts in order: ListRowIcon, ListRowContent, ListRowEnd. */
  children?: ReactNode;
}
/** A row. @since 1.0 */
export const ListRow = el<ListRowProps>("ListRow");

/** @since 1.0 */
export interface ListRowIconProps {
  /** An SF Symbol name. */
  icon: string;
  /** A status light that takes the icon's place (an agent's state). */
  light?: Light;
  tone?: Light | "dim";
}
/** A row's icon, or its status light. @since 1.0 */
export const ListRowIcon = el<ListRowIconProps>("ListRowIcon");

/** @since 1.0 */
export interface ListRowContentProps {
  title: string | number;
  /** Dim, after the title (one-line rows); gives way first. */
  place?: string | number;
  /** A second line under the title. */
  detail?: string | number | null;
  tone?: "needs" | "danger";
  mono?: boolean;
}
/** A row's text. @since 1.0 */
export const ListRowContent = el<ListRowContentProps>("ListRowContent");

/** @since 1.0 */
export interface ListRowEndProps {
  children?: ReactNode;
}
/** A row's right end: a chip, an age, a badge. @since 1.0 */
export const ListRowEnd = el<ListRowEndProps>("ListRowEnd");

/** @since 1.0 */
export interface ChipProps {
  /** A hue (0–360) for its tint; the neutral one without. */
  hue?: number;
  tip?: string;
  children?: ReactNode;
}
/** A small pill of text (an age, a branch). @since 1.0 */
export const Chip = el<ChipProps>("Chip");

// ── numbers ─────────────────────────────────────────────

/** @since 1.0 */
export interface StatProps {
  label: string;
  value: string | number;
  unit?: string;
  /** A change beside it ("+12%"). */
  delta?: string | number;
  deltaTone?: Tone;
  /** Pressed (show what it counts). */
  onSelect?: () => void;
}
/** A number with its label. @since 1.0 */
export const Stat = el<StatProps>("Stat");

/** @since 1.0 */
export interface SparklineProps {
  values: (number | null)[];
  /** In px (default 20). */
  height?: number;
  area?: boolean;
  color?: "current" | "neutral";
}
/** A small line of recent values. @since 1.0 */
export const Sparkline = el<SparklineProps>("Sparkline");

/** @since 1.0 */
export interface ProgressProps {
  /** 0–1; without one it is indeterminate. */
  value?: number;
  tone?: Tone;
  label?: string;
}
/** A progress bar. @since 1.0 */
export const Progress = el<ProgressProps>("Progress");

// ── text and status ─────────────────────────────────────

/** @since 1.0 */
export interface TextProps {
  tone?: "dim" | Tone;
  size?: TextSize;
  mono?: boolean;
  strong?: boolean;
  /** One line, cut with an ellipsis. */
  truncate?: boolean;
  /** Selectable, for a value to copy. */
  select?: boolean;
  /** Balanced line breaks (a heading). */
  balance?: boolean;
  children?: ReactNode;
}
/** Words. @since 1.0 */
export const Text = el<TextProps>("Text");

/** @since 1.0 */
export interface BadgeProps {
  tone?: Tone;
  size?: "sm" | "md";
  solid?: boolean;
  tip?: string;
  children?: ReactNode;
}
/** A label in a tone ("failed", "3 new"). @since 1.0 */
export const Badge = el<BadgeProps>("Badge");

/** @since 1.0 */
export interface StatusDotProps {
  state?: Light;
  size?: "sm" | "md";
  /** Its accessible name. */
  label?: string;
}
/** A small status light. @since 1.0 */
export const StatusDot = el<StatusDotProps>("StatusDot");

/** @since 1.0 */
export interface CalloutProps {
  tone?: Tone;
  title?: string;
  /** An SF Symbol name; by default the tone's. */
  icon?: string;
  /** One small line. */
  compact?: boolean;
  /** Full width along the view's top edge. */
  banner?: boolean;
  /** Shows a close button. */
  onDismiss?: () => void;
  children?: ReactNode;
}
/** A note in a box: a warning, an error, a tip. @since 1.0 */
export const Callout = el<CalloutProps>("Callout");

/** @since 1.0 */
export interface EmptyStateProps {
  /** An SF Symbol name. */
  icon?: string;
  title?: string;
  text?: string;
  action?: Action;
  compact?: boolean;
}
/** What a view shows when it has nothing: what's missing and how to get some. @since 1.0 */
export const EmptyState = el<EmptyStateProps>("EmptyState");

// ── controls ────────────────────────────────────────────

/** @since 1.0 */
export interface ButtonProps {
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "sm" | "md" | "lg";
  /** An SF Symbol name before the label. */
  icon?: string;
  pressed?: boolean;
  /** A spinner, and disabled. */
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children?: ReactNode;
}
/** A button. @since 1.0 */
export const Button = el<ButtonProps>("Button");

/** Each element's props type, by name (tests hold them to the protocol's allow-list). */
export interface ElementProps {
  Window: WindowProps;
  View: ViewProps;
  WindowToolbar: WindowToolbarProps;
  ToolbarButton: ToolbarButtonProps;
  ToolbarField: ToolbarFieldProps;
  ToolbarSearchField: ToolbarSearchFieldProps;
  ToolbarSegmented: ToolbarSegmentedProps;
  ToolbarMenu: ToolbarMenuProps;
  ToolbarText: ToolbarTextProps;
  ToolbarSpacer: Record<string, never>;
  Stack: StackProps;
  Inline: InlineProps;
  Tiles: TilesProps;
  Hide: HideProps;
  List: ListProps;
  ListSection: ListSectionProps;
  ListRow: ListRowProps;
  ListRowIcon: ListRowIconProps;
  ListRowContent: ListRowContentProps;
  ListRowEnd: ListRowEndProps;
  Chip: ChipProps;
  Stat: StatProps;
  Sparkline: SparklineProps;
  Text: TextProps;
  Badge: BadgeProps;
  StatusDot: StatusDotProps;
  Button: ButtonProps;
  EmptyState: EmptyStateProps;
  Callout: CalloutProps;
  Progress: ProgressProps;
}
