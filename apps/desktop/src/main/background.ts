// Background mode (CMD_BACKGROUND=1, set by the e2e scripts): the app never
// takes focus from whatever you're working in, nor shows up on screen. No Dock
// icon, windows appear without activating the app, fully transparent and
// letting the mouse through (Playwright's input goes over CDP), focus and
// activation requests are dropped, and system notifications aren't posted.
// macOS orders even an inactive app's new windows in front of yours, and
// clamps windows moved off-screen back onto it, so transparency is what hides them.
// Pages still act focused (Playwright emulates focus over CDP); for the main
// process, the last window shown or focused stands in as the focused one.
// Nobody sees these windows, so Chromium must not throttle or stop painting them.
import { app, BrowserWindow, Notification } from "electron";

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
  BrowserWindow.prototype.showInactive = function () {
    this.setOpacity(0);
    this.setIgnoreMouseEvents(true);
    showInactive.call(this);
  };
  BrowserWindow.prototype.show = function () {
    this.showInactive();
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
  Notification.prototype.show = function () {};
}
