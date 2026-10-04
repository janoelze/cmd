// One scrollbar look for every window: lists, editors, Markdown, terminals and the
// pages inside browser windows (BrowserView injects SCROLLBAR_CSS into each page).
// Minimal: no track, a thin, faint thumb that thickens and brightens under the
// pointer. The hit area stays 10px wide; a transparent border narrows what's drawn.
// Gray reads on dark panes and white pages. (Showing the thumb only while the
// scroller is hovered doesn't work: Chromium doesn't repaint it reliably.)

const THUMB = "rgb(128 128 128 / 0.34)";
const THUMB_HOVER = "rgb(128 128 128 / 0.62)";
const THUMB_ACTIVE = "rgb(128 128 128 / 0.8)";

export const SCROLLBAR_CSS = `
::-webkit-scrollbar { width: 10px; height: 10px; background: transparent; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb {
  min-height: 32px;
  min-width: 32px;
  border: 3px solid transparent;
  border-radius: 5px;
  background: ${THUMB} padding-box;
}
::-webkit-scrollbar-thumb:hover { border-width: 2px; background-color: ${THUMB_HOVER}; }
::-webkit-scrollbar-thumb:active { border-width: 2px; background-color: ${THUMB_ACTIVE}; }
`;

/**
 * xterm.js draws its own scrollbar (and fades it out); style its slider the same,
 * always shown, but only when there is scrollback (terminals.ts sets .scrollable).
 */
const XTERM_CSS = `
.xterm .xterm-scrollable-element > .scrollbar.vertical > .slider {
  left: auto !important;
  right: 3px;
  width: 4px !important;
  border-radius: 2px;
  background: ${THUMB} !important;
}
.xterm .xterm-scrollable-element > .scrollbar.vertical:hover > .slider,
.xterm .xterm-scrollable-element > .scrollbar.vertical > .slider.active {
  right: 2px;
  width: 6px !important;
  border-radius: 3px;
  background: ${THUMB_HOVER} !important;
}
.xterm .xterm-scrollable-element > .scrollbar.vertical > .slider.active { background: ${THUMB_ACTIVE} !important; }
.xterm-host.scrollable .xterm .xterm-scrollable-element > .scrollbar.vertical.invisible { opacity: 1; }
.xterm-host:not(.scrollable) .xterm .xterm-scrollable-element > .scrollbar.vertical { opacity: 0; pointer-events: none; }
.xterm .xterm-scrollable-element > .shadow { display: none; }
`;

export function installScrollbars(): void {
  const style = document.createElement("style");
  style.dataset.cmd = "scrollbars";
  style.textContent = SCROLLBAR_CSS + XTERM_CSS;
  document.head.appendChild(style);
}
