// Background mode (CMD_BACKGROUND=1, set by the e2e scripts): the app never
// takes focus from whatever you're working in. No Dock icon, windows appear
// without activating the app, and focus/activation requests are dropped.
// Pages still act focused (Playwright emulates focus over CDP); for the main
// process, the last window shown or focused stands in as the focused one.
// Windows sit behind yours, so Chromium must not throttle or stop painting them.
import { app, BrowserWindow } from "electron";

export const background = !!process.env.CMD_BACKGROUND;

if (background) {
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("disable-features", "MacWebContentsOcclusion,CalculateNativeWinOcclusion");

  // Most recently focused last; closing one hands focus to the one before, as macOS does.
  let order: BrowserWindow[] = [];
  const focused = () => {
    order = order.filter((w) => !w.isDestroyed() && w.isVisible());
    return order.at(-1) ?? null;
  };
  const take = (w: BrowserWindow) => {
    if (focused() === w) return;
    order = [...order.filter((o) => o !== w), w];
    w.emit("focus");
  };
  const { showInactive } = BrowserWindow.prototype;
  BrowserWindow.prototype.show = function () {
    showInactive.call(this);
    take(this);
  };
  BrowserWindow.prototype.focus = function () {
    take(this);
  };
  BrowserWindow.prototype.isFocused = function () {
    return focused() === this;
  };
  BrowserWindow.prototype.moveTop = function () {};
  BrowserWindow.getFocusedWindow = focused;
  app.focus = () => {};
}
