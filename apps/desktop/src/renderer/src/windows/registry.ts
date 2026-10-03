// Renderer half of a window type: how a kind of window looks and behaves in the
// UI. The core half (what it opens, its state) lives in packages/core/src/windows.
// Built-ins register in ./builtin.tsx; plugin window types will register the same way.

import { createElement, lazy, Suspense, type ComponentType } from "react";
import type { AppWindow, WindowTypeInfo } from "@cmd/protocol";
import type { MenuEntry } from "../context.ts";

export interface WindowViewProps {
  win: AppWindow;
  /** This window is the selected one (take keyboard focus, refresh, …). */
  focused: boolean;
}

export interface WindowView {
  kind: string;
  /** The window's content (below the shared title bar). */
  View: ComponentType<WindowViewProps>;
  /**
   * The window's Name (defaults to its title) and Place (host, folder, …), see
   * docs/10-window-titles.md. `kind: null` hides the Kind (when the icon and
   * name already say it). Kind comes from the type; Status and Dirty from
   * the window's live status (setWindowStatus).
   */
  describe?(win: AppWindow): { name?: string; place?: string; kind?: string | null };
  /** Context-menu entries for the title bar and sidebar row. */
  menu?(win: AppWindow): MenuEntry[];
}

const views = new Map<string, WindowView>();

/**
 * A view whose code loads on first use, so heavy dependencies (an editor, a
 * Markdown renderer) stay out of the startup bundle. Shows an empty well meanwhile.
 */
export function lazyView(load: () => Promise<ComponentType<WindowViewProps>>): ComponentType<WindowViewProps> {
  const View = lazy(async () => ({ default: await load() }));
  const fallback = createElement("div", { style: { flex: 1, background: "var(--well)" } });
  return (props) => createElement(Suspense, { fallback }, createElement(View, props));
}

export function registerWindowView(view: WindowView): void {
  views.set(view.kind, view);
}

export function viewFor(kind: string): WindowView | undefined {
  return views.get(kind);
}

/** Type info from the core (title, icon) for kinds without a registered view too. */
let typeInfo = new Map<string, WindowTypeInfo>();
export function setWindowTypes(types: WindowTypeInfo[]): void {
  typeInfo = new Map(types.map((t) => [t.kind, t]));
}
export function typeFor(kind: string): WindowTypeInfo | undefined {
  return typeInfo.get(kind);
}

/** Typed access to a window's state. */
export const stateStr = (win: AppWindow, key: string): string | undefined =>
  typeof win.state[key] === "string" ? (win.state[key] as string) : undefined;
