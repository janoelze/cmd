// Opening URLs and files in other apps: every shell.openExternal and
// shell.openPath in main goes through here, behind open-policy.ts. The app's
// pages ask over two channels, by intent: "open-external" (a URL) and
// "open-file" (a path), each with where the target came from. An "ask" is a
// native sheet on the window that asked, like cmd.confirm's: main decides on its
// own, with nothing the page can answer for it. A target cmd couldn't open (no
// app for the scheme, a missing file) says so in an alert, not a crash.

import { app, BrowserWindow, dialog, ipcMain, shell, type MessageBoxOptions } from "electron";
import { logger } from "@cmd/protocol/node";
import { classify, confirmText, fileInfo, isUrl, linkInFile, openPolicy, type OpenFrom } from "./open-policy.ts";

const log = logger("open");

const show = (win: BrowserWindow | null, opts: MessageBoxOptions) => (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));

/**
 * Open a URL or file per the policy, asking first when it says so. Resolves
 * with why it didn't open ("" when it did, or the person said no).
 */
export async function openTarget(target: string, from: OpenFrom, win: BrowserWindow | null = null): Promise<string> {
  const t = classify(target);
  const verdict = openPolicy(target, from);
  if (verdict === "deny") {
    log.warn("refused to open", { target: target.slice(0, 200), from });
    return "";
  }
  if (verdict === "ask") {
    const info = t.type === "file" ? fileInfo(t.path) : null;
    const appName = t.type === "url" ? app.getApplicationNameForProtocol(t.url).replace(/\.app$/, "") : undefined;
    const link = t.type === "file" && t.launcher === "link" ? linkInFile(info?.real ?? t.path) : null;
    const c = confirmText(t, { appName: appName || undefined, real: info?.real, link });
    const { response } = await show(win, { type: "warning", message: c.message, detail: c.detail, buttons: [c.button, "Cancel"], defaultId: 1, cancelId: 1 });
    log.info(`${response === 0 ? "opened" : "didn't open"} after asking`, { target: target.slice(0, 200) });
    if (response !== 0) return "";
  }
  return t.type === "url" ? await shell.openExternal(t.url).then(() => "", (err: Error) => err.message) : await shell.openPath(t.path);
}

/** From a menu or cmd's own code: opens without asking (javascript: and the like still don't). */
export const openForUser = (target: string): Promise<string> => openTarget(target, "user");

const fromOf = (o: unknown): OpenFrom => ((o as { from?: unknown } | null)?.from === "user" ? "user" : "content");

async function handle(win: BrowserWindow | null, target: string, from: OpenFrom): Promise<void> {
  const error = await openTarget(target, from, win);
  if (!error) return;
  log.warn("could not open", { target, error });
  void show(win, { type: "warning", message: `cmd could not open ${target}`, detail: error });
}

/** The pages' two channels. Anything but a string of the channel's kind is dropped. */
export function handleOpen(): void {
  ipcMain.on("open-external", (e, url: unknown, o: unknown) => {
    if (typeof url !== "string" || !isUrl(url)) return log.warn("open-external without a URL", { url: String(url).slice(0, 200) });
    void handle(BrowserWindow.fromWebContents(e.sender), url, fromOf(o));
  });
  ipcMain.on("open-file", (e, p: unknown, o: unknown) => {
    if (typeof p !== "string" || !p || isUrl(p)) return log.warn("open-file without a path", { path: String(p).slice(0, 200) });
    void handle(BrowserWindow.fromWebContents(e.sender), p, fromOf(o));
  });
}
