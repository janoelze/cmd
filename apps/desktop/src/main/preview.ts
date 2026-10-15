// Widget previews for the core (docs/56, "Magic on V3"): a Magic build asks for a package
// widget's trees to be drawn (magic.previewRequest), and the app draws them with its own kit in
// the renderer's preview page (renderer/src/preview), offscreen, on a closed session that may
// load only that page's own files: the tree is data, no widget code runs. Each draw reports
// errors (the page's, the console's, the tree's), what was drawn, whether it fits, and a
// screenshot when asked. One window, reused, one batch at a time. Why the app draws and not
// only Playwright: under `pnpm dev` there is no built preview page for Playwright to load
// (the dev server serves it), and a checkout's install doesn't download Playwright's Chromium.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, session } from "electron";
import { previewScript, type MagicPreviewRequest, type MagicPreviewShot } from "@cmd/protocol";
import { connect, logger } from "@cmd/protocol/node";

const log = logger("preview");
const PARTITION = "cmd-widget-preview";

let win: BrowserWindow | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** The preview page: the dev server's, else the build's beside this file (apps/desktop/out/main). */
const PAGE = process.env.ELECTRON_RENDERER_URL ? `${process.env.ELECTRON_RENDERER_URL}/preview.html` : pathToFileURL(path.join(import.meta.dirname, "../renderer/preview.html")).href;
/** What the page may load: its own folder (scripts, styles, fonts), and data: URLs. */
const ROOT = PAGE.slice(0, PAGE.lastIndexOf("/") + 1);

/** The preview page, loaded once in a window of its own on a closed session. */
async function previewWindow(): Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) return win;
  const ses = session.fromPartition(PARTITION);
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url.startsWith("data:") || d.url.startsWith(ROOT)) }));
  ses.setPermissionRequestHandler((_wc, _p, done) => done(false));
  const w = new BrowserWindow({
    show: false,
    width: 480,
    height: 320,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses, backgroundThrottling: false },
  });
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  await w.loadURL(PAGE);
  win = w;
  return w;
}

async function renderOne(r: MagicPreviewRequest): Promise<MagicPreviewShot> {
  const w = await previewWindow();
  w.setContentSize(Math.max(120, Math.round(r.width)), Math.max(80, Math.round(r.height)));
  const errors: string[] = [];
  const onConsole = (e: { level: string; message: string }) => {
    if (e.level === "error" && !/Content Security Policy/.test(e.message)) errors.push(e.message);
  };
  w.webContents.on("console-message", onConsole as never);
  try {
    const m = (await w.webContents.executeJavaScript(previewScript(r.tree), true)) as MagicPreviewShot;
    const png = r.shot ? (await w.webContents.capturePage()).toPNG().toString("base64") : undefined;
    return { ...m, errors: [...m.errors, ...errors], png };
  } finally {
    w.webContents.off("console-message", onConsole as never);
  }
}

function render(requests: MagicPreviewRequest[]): Promise<MagicPreviewShot[]> {
  const run = queue.then(async () => {
    const out: MagicPreviewShot[] = [];
    for (const r of requests) out.push(await renderOne(r));
    return out;
  });
  queue = run.catch(() => {});
  return run;
}

/** Be the core's previewer; reconnects when the core restarts. */
export function servePreviews(socketPath: string): void {
  const attach = async () => {
    try {
      const conn = await connect(socketPath);
      conn.client.onEvent((e) => {
        if (e.type !== "magic.previewRequest") return;
        render(e.requests).then(
          (shots) => void conn.client.call("magic.previewResult", { reqId: e.reqId, shots }).catch(() => {}),
          (err: Error) => {
            log.warn(`preview failed: ${err.message}`);
            void conn.client.call("magic.previewResult", { reqId: e.reqId, error: err.message }).catch(() => {});
          },
        );
      });
      await conn.client.call("magic.previewer", {});
      conn.closed.then(() => setTimeout(attach, 500));
    } catch {
      setTimeout(attach, 500);
    }
  };
  void attach();
}
