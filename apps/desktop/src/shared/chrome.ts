// Window chrome sizes shared by main (where macOS draws the traffic lights) and
// the renderer (the bars they sit in), so the lights stay centred in them.
// macOS doesn't report a title bar height (Electron can't either); its own are
// 28 pt (title bar), 38 pt (compact toolbar) and 52 pt (toolbar).

/** The app window's top bar (docs/21-sidebars.md). */
export const TOPBAR_HEIGHT = 38;
/** The Settings window's sidebar title row (its --titlebar-h). */
export const SETTINGS_TITLEBAR_HEIGHT = 38;

/** The traffic lights' button frames are 14 pt tall; `trafficLightPosition` is their top left. */
const LIGHTS_HEIGHT = 14;

/** Traffic lights centred in a bar `height` px tall. */
export function trafficLights(height: number): { x: number; y: number } {
  return { x: 14, y: Math.round((height - LIGHTS_HEIGHT) / 2) };
}
