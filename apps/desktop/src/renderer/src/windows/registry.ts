// Renderer half of a window type: how a kind of window looks and behaves in the
// UI. The core half (what it opens, its state) lives in packages/core/src/windows.
// Built-ins register in ./builtin.tsx; plugin window types will register the same way.

import { createContext, createElement, lazy, Suspense, useSyncExternalStore, type ComponentType } from "react";
import type { AppWindow, WindowTypeInfo } from "@cmd/protocol";
import type { MenuEntry } from "../lib/context.ts";

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
  describe?(win: AppWindow): { name?: string; place?: string; kind?: string | null; icon?: string };
  /** Its toolbar shows the Place (an address, a path): the title bar leaves it out; sidebar rows keep it. */
  placeInToolbar?: boolean;
  /** Context-menu entries for the title bar and sidebar row. */
  menu?(win: AppWindow): MenuEntry[];
  /** The window's own main actions: first in that menu, above Show, Move and Close. */
  actions?(win: AppWindow): MenuEntry[];
  /**
   * A menu button at the right end of the title bar, labelled with the current
   * choice ("This Workspace ▾"): a widget's scope and options. Not shown on sidebars.
   */
  titleMenu?(win: AppWindow): { label: string; entries: MenuEntry[] } | undefined;
}

/**
 * Where a window is shown: on the board, or docked as a sidebar
 * (docs/21-sidebars.md). Views can read it to adapt (useContext).
 */
export const PlacementContext = createContext<"board" | "sidebar">("board");

const views = new Map<string, WindowView>();

/**
 * A view whose code loads on first use, so heavy dependencies (an editor, a
 * Markdown renderer) stay out of the startup bundle. Shows an empty well meanwhile.
 */
export function lazyView(load: () => Promise<ComponentType<WindowViewProps>>): ComponentType<WindowViewProps> {
  // A chunk that fails to load throws to the window's ErrorBoundary (WindowContent);
  // React keeps a rejected lazy rejected, so start a fresh one for its Reload.
  const make = () =>
    lazy(async () => {
      try {
        return { default: await load() };
      } catch (err) {
        View = make();
        throw err;
      }
    });
  let View = make();
  const fallback = createElement("div", { style: { flex: 1, background: "var(--well)" } });
  return (props) => createElement(Suspense, { fallback }, createElement(View, props));
}

/**
 * A view whose titleMenu, menu or actions read something besides `win` (a package
 * widget's tree, docs/56) says when that changed; title bars redraw (useWindowChrome).
 */
let chromeVersion = 0;
const chromeListeners = new Set<() => void>();
export function windowChromeChanged(): void {
  chromeVersion++;
  for (const fn of chromeListeners) fn();
}
export function useWindowChrome(): number {
  return useSyncExternalStore(
    (fn) => (chromeListeners.add(fn), () => void chromeListeners.delete(fn)),
    () => chromeVersion,
  );
}

export function registerWindowView(view: WindowView): void {
  views.set(view.kind, view);
}

/** A kind's view; a package's widgets ("pkg:<package>/<widget>", docs/56) share the "package" view. */
export function viewFor(kind: string): WindowView | undefined {
  return views.get(kind) ?? (kind.startsWith("pkg:") ? views.get("package") : undefined);
}

/** Type info from the core (title, icon) for kinds without a registered view too. */
let typeInfo = new Map<string, WindowTypeInfo>();
export function setWindowTypes(types: WindowTypeInfo[]): void {
  typeInfo = new Map(types.map((t) => [t.kind, t]));
}
export function typeFor(kind: string): WindowTypeInfo | undefined {
  return typeInfo.get(kind);
}

/** Files no window type opens, by what they hold. */
const FILE_ICONS: [RegExp, string][] = [
  [/\.(mp3|m4a|wav|aiff?|flac|ogg|opus|aac|caf|mid|midi)$/i, "waveform"],
  [/\.(mkv|avi|wmv|flv|mpe?g|3gp)$/i, "film"],
  [/\.(heic|heif|tiff?|raw|dng|cr2|nef|psd)$/i, "photo"],
  [/\.(zip|tar|gz|tgz|bz2|xz|zst|7z|rar)$/i, "doc.zipper"],
  [/\.(ttf|otf|woff2?)$/i, "textformat"],
  [/\.(txt|log|ya?ml|toml|ini|env|csv|tsv|xml|html?|css|scss|[cm]?[jt]sx?|swift|zig|rs|go|py|rb|php|java|kt|c|cc|cpp|h|hpp|m|sh|zsh|fish|sql|lua|vue|svelte)$/i, "doc.text"],
];

/**
 * A file's icon in a list (the Files window): its viewer's, the window type that
 * opens it (a video's film, a database's cylinder), so a new viewer brings its files'
 * icon along; else what it holds (audio, an archive), else a plain document. Only
 * dedicated viewers count (a priority), not the browser's claim on HTML.
 */
export function fileIcon(name: string): string {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  let best: WindowTypeInfo | undefined;
  for (const t of typeInfo.values()) {
    const p = t.opens.priority ?? 0;
    if (p > 0 && t.opens.extensions?.includes(ext) && p > (best?.opens.priority ?? 0)) best = t;
  }
  return best?.icon ?? FILE_ICONS.find(([re]) => re.test(name))?.[1] ?? "doc";
}

/** Typed access to a window's state. */
export const stateStr = (win: AppWindow, key: string): string | undefined =>
  typeof win.state[key] === "string" ? (win.state[key] as string) : undefined;
