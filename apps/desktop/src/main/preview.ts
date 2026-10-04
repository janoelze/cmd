// Widget previews for the core (docs/14-magic-v2.md): before a Magic widget is
// shown, the core asks for it to be rendered (magic.previewRequest) with its
// live data and fixtures, in both themes and two sizes. Each page loads in an
// offscreen window on its own session with every request blocked; we report
// script errors, what was drawn, whether it fits, and a screenshot when asked.
// One window, reused, one render at a time.

import { BrowserWindow, session } from "electron";
import { WIDGET_MEASURE, type MagicPreviewRequest, type MagicPreviewShot } from "@cmd/protocol";
import { connect, logger } from "@cmd/protocol/node";

const log = logger("preview");
const PARTITION = "cmd-widget-preview";
const SETTLE_MS = 500;

let win: BrowserWindow | null = null;
let queue: Promise<unknown> = Promise.resolve();

function previewWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  const ses = session.fromPartition(PARTITION);
  // Previews never touch the network (the data is inlined in the page).
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith("data:") }));
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

async function renderOne(r: MagicPreviewRequest): Promise<MagicPreviewShot> {
  const w = previewWindow();
  w.setContentSize(Math.max(120, Math.round(r.width)), Math.max(80, Math.round(r.height)));
  const errors: string[] = [];
  const onConsole = (e: { level: string; message: string }) => {
    if (e.level === "error" && !/Content Security Policy/.test(e.message)) errors.push(e.message);
  };
  w.webContents.on("console-message", onConsole as never);
  try {
    await w.loadURL(`data:text/html;base64,${Buffer.from(r.page).toString("base64")}`);
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
