// Reading the page in a browser window for browser.read (core windows/pages.ts; the tools'
// read tool, docs/51). A small script runs in the page (webview.executeJavaScript) and hands back
// its HTML, or what a CSS selector or an XPath matches there, listed. The HTML becomes Markdown
// here: Mozilla's Readability picks the main content (Firefox's Reader View), Turndown converts
// it, with GitHub's tables and strikethrough.

import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { PageRead, PageReadMode } from "@cmd/protocol";

export interface PageQuery {
  mode: PageReadMode;
  selector?: string;
  max: number;
}

/** What the page hands back: its HTML for Markdown, the listing for css and xpath. */
type Raw = { url: string; title: string; html: string } | { url: string; title: string; text: string; matches: number };

/** The script run in the page for one query; its value is a Raw (or it throws with a message the model can act on). */
export function pageScript(q: PageQuery): string {
  return `(${inPage.toString()})(${JSON.stringify(q)})`;
}

/** Runs in the page: no imports, no closures over this module. */
function inPage(q: PageQuery): Raw {
  const LIST_MAX = 40;
  const base = { url: location.href, title: document.title };
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  const abs = (u: string | null) => {
    try {
      return u ? new URL(u, location.href).href : "";
    } catch {
      return u ?? "";
    }
  };
  if (q.mode === "markdown") {
    let el: Element | null;
    try {
      el = q.selector ? document.querySelector(q.selector) : document.documentElement;
    } catch {
      throw new Error(`"${q.selector}" isn't a CSS selector`);
    }
    if (!el) throw new Error(`nothing matches "${q.selector}"`);
    return { ...base, html: el.outerHTML };
  }
  /** An element in a line: its tag, id and classes, the attributes worth knowing, its text. */
  const describe = (el: Element) => {
    const tag = el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + [...el.classList].slice(0, 3).map((c) => `.${c}`).join("");
    const attrs = ["href", "src", "name", "type", "value", "placeholder", "aria-label", "title", "role", "alt"]
      .map((a) => [a, a === "href" || a === "src" ? abs(el.getAttribute(a)) : el.getAttribute(a)] as const)
      .filter(([, v]) => v)
      .map(([a, v]) => `${a}="${String(v).slice(0, 200)}"`);
    const text = squash((el as HTMLElement).innerText ?? el.textContent ?? "").slice(0, 300);
    return `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>${text ? ` ${text}` : ""}`;
  };
  const found: Node[] = [];
  try {
    if (q.mode === "css") found.push(...document.querySelectorAll(q.selector!));
    else {
      const snap = document.evaluate(q.selector!, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < snap.snapshotLength; i++) found.push(snap.snapshotItem(i)!);
    }
  } catch {
    throw new Error(`"${q.selector}" isn't ${q.mode === "css" ? "a CSS selector" : "an XPath"}`);
  }
  const lines = found.slice(0, LIST_MAX).map((n, i) => `[${i + 1}] ${n.nodeType === Node.ELEMENT_NODE ? describe(n as Element) : squash(n.nodeValue ?? n.textContent ?? "").slice(0, 300)}`);
  return { ...base, matches: found.length, text: lines.join("\n") + (found.length > LIST_MAX ? `\n… ${found.length - LIST_MAX} more` : "") };
}

let turndown: TurndownService | null = null;

/** HTML as Markdown: the main content of a whole page (Readability), or all of one element's. */
export function toMarkdown(html: string, url: string, whole: boolean): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Links and images resolve against the page, not the app.
  for (const el of doc.querySelectorAll("a[href], img[src]")) {
    const attr = el.tagName === "A" ? "href" : "src";
    try {
      el.setAttribute(attr, new URL(el.getAttribute(attr)!, url).href);
    } catch {
      // not a URL: left as written
    }
  }
  const article = whole ? new Readability(doc.cloneNode(true) as Document).parse() : null;
  const content = article?.content ?? (whole ? doc.body.innerHTML : html);
  if (!turndown) {
    turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
    turndown.use(gfm);
    turndown.remove(["script", "style", "noscript", "iframe", "canvas", "button", "form"]);
    turndown.remove((n) => n.nodeName === "svg");
  }
  return turndown.turndown(content).replace(/\n{3,}/g, "\n\n").trim();
}

/** Run a query in a webview and answer as browser.read does. */
export async function readPage(run: (script: string) => Promise<unknown>, q: PageQuery): Promise<PageRead> {
  const raw = (await run(pageScript(q))) as Raw;
  const text = "html" in raw ? toMarkdown(raw.html, raw.url, !q.selector) : raw.text;
  const cut = text.length > q.max;
  return { url: raw.url, title: raw.title, text: cut ? text.slice(0, q.max) : text, ...("matches" in raw ? { matches: raw.matches } : {}), ...(cut ? { cut } : {}) };
}
