// View: the board's layout (focus, grid, strip, canvas), a window's strip width, the
// sidebars and docking, zoom, and a window's other face (⌘E).

import { setUi } from "../../lib/store.ts";
import { cmd } from "../../lib/bridge.ts";
import { togglePreview } from "../../windows/preview.ts";
import { dock, undock } from "../board/docks.ts";
import type { ViewMode } from "../board/layouts.ts";
import { anySideShown, toggleSide, toggleSidebars } from "../board/sidebars.ts";
import { DEFAULT_FRACTION, MIN_WIDTH, nextPreset, stepFraction } from "../board/strip.ts";
import { setDocks, setMode, setStripWidth } from "../board/view.ts";
import { requestCanvas } from "../board/WindowsView.tsx";
import { getState } from "../../lib/store.ts";
import { registerCommands, type Command, type CommandContext } from "./registry.ts";

const mode = (m: ViewMode): Command => ({ run: () => setMode(m), checked: (c) => c.board.mode === m });

/** ⌥⌘+ / ⌥⌘−, ⌃⌘R: the selected window's strip width (the floor roughly MIN_WIDTH, so ⌥⌘+ always shows). */
const width = (next: (fraction: number) => number): Command => ({
  when: (c) => !!c.selected,
  run: (c) => {
    if (c.board.mode !== "strip") setMode("strip");
    setStripWidth(c.selected!, next(c.board.stripWidths[c.selected!] ?? DEFAULT_FRACTION));
  },
});

/** ⌘+ ⌘− ⌘0: the text's size, or the content of a window that zooms its own (a PDF). */
const zoom = (d: 1 | -1 | 0): Command => ({
  run: (c) => {
    if (c.actions?.zoom) return c.actions.zoom(d);
    const z = (getState().ui["terminal.zoom"] as number | undefined) ?? 0;
    setUi("terminal.zoom", d === 0 ? 0 : d > 0 ? Math.min(24, z + 1) : Math.max(-6, z - 1));
  },
});

const shown = (c: CommandContext, side: "left" | "right") => !!c.board.docks[side].id && !c.board.docks[side].hidden;

registerCommands({
  "view.focus": mode("focus"),
  "view.grid": mode("grid"),
  "view.strip": mode("strip"),
  "view.canvas": mode("canvas"),
  "view.toggleFocus": { run: (c) => setMode(c.board.mode === "focus" ? c.board.layoutMode : "focus") },
  "view.canvasFit": { run: () => (setMode("canvas"), requestCanvas("fit")) },
  "view.canvasZoomWindow": { run: () => (setMode("canvas"), requestCanvas("window")) },
  "view.cycleWidth": width(nextPreset),
  "view.widen": width((f) => stepFraction(f, 1, MIN_WIDTH / window.innerWidth)),
  "view.narrow": width((f) => stepFraction(f, -1, MIN_WIDTH / window.innerWidth)),
  "view.magicRefresh": { when: (c) => !!c.actions?.refresh, run: (c) => c.actions?.refresh?.() },
  "view.toggleEdit": { run: (c) => (c.actions?.toggleEdit ? c.actions.toggleEdit() : c.window && togglePreview(c.window)) },
  "view.sidebar": { run: () => toggleSide("left"), checked: (c) => shown(c, "left") },
  "view.rightSidebar": { when: (c) => !!c.board.docks.right.id, run: () => toggleSide("right"), checked: (c) => shown(c, "right") },
  "view.sidebars": { run: () => toggleSidebars(), checked: (c) => anySideShown(c.board.docks) },
  "window.dockLeft": { when: (c) => !!c.selected && c.side !== "left", run: (c) => setDocks((d) => dock(d, c.selected!, "left")) },
  "window.dockRight": { when: (c) => !!c.selected && c.side !== "right", run: (c) => setDocks((d) => dock(d, c.selected!, "right")) },
  "window.undock": { when: (c) => !!c.side, run: (c) => setDocks((d) => undock(d, c.selected!)) },
  // A fixed size for consistent screenshots (marketing site).
  "window.screenshotSize": { run: () => cmd.setWindowSize(1500, 900) },
  "view.zoomIn": zoom(1),
  "view.zoomOut": zoom(-1),
  "view.zoomReset": zoom(0),
});
