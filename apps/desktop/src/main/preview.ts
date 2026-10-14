// Widget previews for the core (docs/14-magic-v2.md): before a Magic widget is
// shown, the core asks for it to be rendered (magic.previewRequest) with its
// live data and fixtures, in both themes and two sizes. Each page loads in an
// offscreen window on its own session with every request blocked; we report
// script errors, what was drawn, whether it fits, and a screenshot when asked.
// A widget package's tree (docs/56, "Magic on V3") is drawn by the renderer's own
// preview page (renderer/src/preview), the only thing that session may load: the
// tree is data, drawn with the kit. One window each, reused, one render at a time.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, session } from "electron";
import { WIDGET_MEASURE, type MagicPreviewRequest, type MagicPreviewShot } from "@cmd/protocol";
import { connect, logger } from "@cmd/protocol/node";

const log = logger("preview");
const PARTITION = "cmd-widget-preview";
const SETTLE_MS = 500;

let win: BrowserWindow | null = null;
let treeWin: BrowserWindow | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** The preview page: the dev server's, else the build's beside this file (apps/desktop/out/main). */
const TREE_PAGE = process.env.ELECTRON_RENDERER_URL ? `${process.env.ELECTRON_RENDERER_URL}/preview.html` : pathToFileURL(path.join(import.meta.dirname, "../renderer/preview.html")).href;
/** What the page may load: its own folder (scripts, styles, fonts). */
const TREE_ROOT = TREE_PAGE.slice(0, TREE_PAGE.lastIndexOf("/") + 1);

function previewWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  const ses = session.fromPartition(PARTITION);
  // Previews never touch the network (the data is inlined in the page; a tree's page loads its own files).
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url.startsWith("data:") || d.url.startsWith(TREE_ROOT)) }));
  ses.setPermissionRequestHandler((_wc, _p, done) => done(false));
  win = new BrowserWindow({
    show: false,
    width: 480,
    height: 320,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, session: ses, backgroundThrottling: false, javascript: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  return win;
}

/** The preview page, loaded once in a window of its own on the same closed session. */
async function treeWindow(): Promise<BrowserWindow> {
  if (treeWin && !treeWin.isDestroyed()) return treeWin;
  previewWindow(); // the session's rules
  const w = new BrowserWindow({
    show: false,
    width: 480,
    height: 320,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, session: session.fromPartition(PARTITION), backgroundThrottling: false },
  });
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  await w.loadURL(TREE_PAGE);
  treeWin = w;
  return w;
}

async function renderTree(r: MagicPreviewRequest): Promise<MagicPreviewShot> {
  const w = await treeWindow();
  w.setContentSize(Math.max(120, Math.round(r.width)), Math.max(80, Math.round(r.height)));
  const m = (await w.webContents.executeJavaScript(`window.__cmdPreview(${JSON.stringify(r.tree)})`, true)) as Omit<MagicPreviewShot, "png">;
  const png = r.shot ? (await w.webContents.capturePage()).toPNG().toString("base64") : undefined;
  return { ...m, png };
}

async function renderOne(r: MagicPreviewRequest): Promise<MagicPreviewShot> {
  if (r.tree) return renderTree(r);
  const w = previewWindow();
  w.setContentSize(Math.max(120, Math.round(r.width)), Math.max(80, Math.round(r.height)));
  const errors: string[] = [];
  const onConsole = (e: { level: string; message: string }) => {
    if (e.level === "error" && !/Content Security Policy/.test(e.message)) errors.push(e.message);
  };
  w.webContents.on("console-message", onConsole as never);
  try {
    await w.loadURL(`data:text/html;base64,${Buffer.from(r.page ?? "").toString("base64")}`);
    await new Promise((res) => setTimeout(res, SETTLE_MS));
    const m = (await w.webContents.executeJavaScript(WIDGET_MEASURE, true)) as Omit<MagicPreviewShot, "png">;
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
