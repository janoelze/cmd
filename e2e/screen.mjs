// E2E_SCREEN: run an e2e script as on another screen, so failures that only
// happen on CI's smaller one reproduce on a laptop. `E2E_SCREEN=ci` is the
// GitHub macOS runner: a 1024 × 768 display at 1x whose work area (1024 × 674)
// macOS fits the 1400 × 900 app window into when it is shown;
// `E2E_SCREEN=1280x800` or `1280x800@2` is any work area, @ the device scale.
// Every app window is kept inside that area from the top left of the primary
// display, as macOS keeps windows inside a real screen: placed and sized into
// it at launch, and clamped again whenever one is created, resized or maximized.
// Unset, nothing changes. Every run prints the real display, and the window and
// page once shown (sizes read before that are the requested ones), so CI's log
// says what it ran on.

const PRESETS = { ci: "1024x674@1" };

/** The emulated work area and scale, or null to use the real screen. */
export const e2eScreen = (() => {
  const raw = process.env.E2E_SCREEN?.trim();
  if (!raw) return null;
  const m = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(PRESETS[raw] ?? raw);
  if (!m) throw new Error(`E2E_SCREEN: "${raw}" is neither a preset (${Object.keys(PRESETS).join(", ")}) nor WIDTHxHEIGHT[@SCALE]`);
  return { width: +m[1], height: +m[2], scale: m[3] ? +m[3] : null };
})();

/** Environment for electron.launch: the device scale, when the screen sets one. */
export const screenEnv = () => (e2eScreen?.scale ? { CMD_FORCE_SCALE: String(e2eScreen.scale) } : {});

/** After launch: print the display and window, and fit every window to E2E_SCREEN if set. */
export async function fitScreen(app, win) {
  await win.waitForLoadState("domcontentloaded").catch(() => {});
  // Windows are created hidden and shown at ready-to-show; macOS fits a window into
  // the screen only then, so read the bounds after that (before it, CI's 1400 x 900
  // window still reads 1400 x 900, partly off a 1024 x 768 display).
  await app
    .evaluate(({ BrowserWindow }) => new Promise((resolve) => {
      const t0 = Date.now();
      const poll = () => (BrowserWindow.getAllWindows()[0]?.isVisible() || Date.now() - t0 > 10_000 ? setTimeout(resolve, 100) : setTimeout(poll, 50));
      poll();
    }))
    .catch(() => {});
  const info = await app.evaluate(({ app, BrowserWindow, screen }, s) => {
    const d = screen.getPrimaryDisplay();
    if (s) {
      const area = { x: d.workArea.x, y: d.workArea.y, width: s.width, height: s.height };
      const fit = (w) => {
        if (w.isDestroyed() || w.isFullScreen()) return;
        const b = w.getBounds();
        const width = Math.min(b.width, area.width);
        const height = Math.min(b.height, area.height);
        const x = Math.min(Math.max(b.x, area.x), area.x + area.width - width);
        const y = Math.min(Math.max(b.y, area.y), area.y + area.height - height);
        if (x !== b.x || y !== b.y || width !== b.width || height !== b.height) w.setBounds({ x, y, width, height });
      };
      const watch = (w) => {
        fit(w);
        for (const e of ["resize", "maximize", "show"]) w.on(e, () => fit(w));
      };
      BrowserWindow.getAllWindows().forEach(watch);
      app.on("browser-window-created", (_e, w) => watch(w));
    }
    const w = BrowserWindow.getAllWindows()[0];
    return { size: d.size, workArea: d.workArea, scaleFactor: d.scaleFactor, window: w?.getBounds(), content: w?.getContentBounds() };
  }, e2eScreen);
  const page = await win.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => null);
  const r = (b) => (b ? `${b.width}x${b.height}${b.x !== undefined ? ` at ${b.x},${b.y}` : ""}` : "none");
  console.log(
    `screen: display ${r(info.size)} @${info.scaleFactor}x, work area ${r(info.workArea)}, window ${r(info.window)}, content ${r(info.content)}, page ${r(page)}` +
      (e2eScreen ? ` (E2E_SCREEN=${process.env.E2E_SCREEN})` : ""),
  );
  return info;
}
