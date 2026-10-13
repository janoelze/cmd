// Reading a browser window's page (browser.read): the page lives in the app's renderer, in a
// webview the core can't reach, so the core asks the app windows (the browser.request event)
// and the one showing that window answers (browser.reply), through AppAsk (app-ask.ts).
// Acting on it (browser.act: click, fill, submit) goes the same way. Used by the tools' read
// and page tools (docs/51); fails plainly when no app window shows the page.

import type { PageAction, PageActed, PageRead, PageReadMode, WindowId } from "@cmd/protocol";
import type { CoreContext } from "../kernel/context.ts";
import { appAsk } from "./app-ask.ts";

/** How long the app has to answer: a page that is loading answers once it can. */
const REPLY_MS = 8000;
const MAX_DEFAULT = 24_000;

export function readPage(core: Pick<CoreContext, "broadcast">, id: WindowId, mode: PageReadMode, selector?: string, max = MAX_DEFAULT): Promise<PageRead> {
  if (mode !== "markdown" && !selector?.trim()) return Promise.reject(new Error(`${mode} needs a selector`));
  return appAsk(core).ask<PageRead>(
    (reqId) => ({ type: "browser.request", reqId, id, mode, selector, max: Math.min(Math.max(max, 1000), 100_000) }),
    REPLY_MS,
    "no app window shows this page right now (it may be in another workspace, or still loading): show it and read again",
  );
}

/** Act on a page (or, dry, find and describe the element); the app window showing it does. */
export function actOnPage(core: Pick<CoreContext, "broadcast">, id: WindowId, a: { action: PageAction; selector: string; index?: number; value?: string; dry?: boolean }): Promise<PageActed> {
  if (!a.selector.trim()) return Promise.reject(new Error("give a CSS selector for the element"));
  return appAsk(core).ask<PageActed>((reqId) => ({ type: "browser.actRequest", reqId, id, ...a }), REPLY_MS, "no app window shows this page right now: show it and try again");
}
