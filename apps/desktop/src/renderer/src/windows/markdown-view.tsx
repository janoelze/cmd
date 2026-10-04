// Markdown window view: renders a .md file (GitHub-flavoured: tables, task lists),
// live — the file is watched and re-rendered in place, keeping the scroll
// position. Code blocks are highlighted with the editor's parsers and colours.
// Links: http(s) → cmd browser window, other .md files → this window, #anchors
// scroll, other paths → whatever window type handles them. Relative images load
// through the app's read-only cmd-file: protocol. Loaded lazily (see markdown.tsx):
// marked, DOMPurify and the highlighters stay out of the startup bundle.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode } from "@lezer/highlight";
import { StyleModule } from "style-mod";
import { cmd } from "../bridge.ts";
import { openLink, openPath, selectPane } from "../actions.ts";
import { syntax } from "../editor/syntax.ts";
import { onFsChanged } from "../store.ts";
import { registerWindowActions, setWindowStatus } from "../windowActions.ts";
import { stateStr, type WindowViewProps } from "./registry.ts";

// The highlight style's CSS is normally mounted by an editor; mount it for static use.
StyleModule.mount(document, syntax.module!);

// Paths may use "\\" on Windows; results use "/", which Windows accepts too.
const isAbsolute = (p: string) => p.startsWith("/") || /^[a-z]:[\\/]/i.test(p);
const dirOf = (p: string) => p.split(/[\\/]/).slice(0, -1).join("/") || "/";

/** Resolve a link/src relative to the Markdown file. */
function resolveRelative(base: string, href: string): string {
  if (isAbsolute(href)) return href;
  const parts = base.split(/[\\/]/);
  for (const seg of href.split(/[\\/]/)) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/") || "/";
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");

/** Markdown → sanitized HTML (GFM). */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { gfm: true, async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}

/** Highlight a code block in place with the editor's language parsers. */
async function highlightBlock(code: HTMLElement): Promise<void> {
  const lang = /language-([\w+#-]+)/.exec(code.className)?.[1];
  if (!lang) return;
  const desc = LanguageDescription.matchLanguageName(languages, lang, true);
  if (!desc) return;
  const support = await desc.load();
  const text = code.textContent ?? "";
  const frag = document.createDocumentFragment();
  highlightCode(
    text,
    support.language.parser.parse(text),
    syntax,
    (t, classes) => {
      if (!classes) return void frag.append(t);
      const span = document.createElement("span");
      span.className = classes;
      span.textContent = t;
      frag.append(span);
    },
    () => frag.append("\n"),
  );
  code.replaceChildren(frag);
}

export function MarkdownView({ win, focused }: WindowViewProps) {
  const file = stateStr(win, "path") ?? "";
  const base = dirOf(file);
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await cmd.call("fs.read", { path: file });
      setSource(r.text);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [file]);
  useEffect(() => void load(), [load]);

  // Live: re-render when the file changes (scroll position is kept: same container).
  useEffect(() => {
    void cmd.call("fs.watch", { path: file }).catch(() => {});
    const off = onFsChanged((p) => p === file && void load());
    return () => {
      off();
      void cmd.call("fs.unwatch", { path: file }).catch(() => {});
    };
  }, [file, load]);

  const html = useMemo(() => (source === null ? "" : renderMarkdown(source)), [source]);

  // After rendering: anchor ids, local image sources, code highlighting.
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    el.innerHTML = html;
    for (const h of el.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")) if (!h.id) h.id = slug(h.textContent ?? "");
    for (const img of el.querySelectorAll<HTMLImageElement>("img")) {
      const src = img.getAttribute("src") ?? "";
      // The path goes in the query: a Windows drive letter would parse as the URL's host.
      if (src && (isAbsolute(src) || !/^[a-z][\w+.-]*:/i.test(src))) img.src = `cmd-file://local/?path=${encodeURIComponent(resolveRelative(base, src))}`;
    }
    for (const code of el.querySelectorAll<HTMLElement>("pre > code")) void highlightBlock(code).catch(() => {});
    // GFM task list checkboxes are display-only.
    for (const box of el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) box.disabled = true;
  }, [html, base]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href");
    if (!a || !href) return;
    e.preventDefault();
    if (href.startsWith("#")) {
      body.current?.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`)?.scrollIntoView({ block: "start" });
    } else if (/^https?:/i.test(href)) {
      openLink(href); // cmd browser window or default browser (open.links)
    } else if (/^[a-z][\w+.-]*:/i.test(href)) {
      cmd.openPath(href); // mailto:, other apps
    } else {
      const [p] = href.split("#");
      const target = resolveRelative(base, decodeURIComponent(p ?? ""));
      if (/\.(md|markdown|mdx)$/i.test(target)) void cmd.call("window.update", { id: win.id, state: { path: target } });
      else void openPath(target);
    }
  };

  useEffect(() => {
    if (focused) scroller.current?.focus();
  }, [focused]);

  const words = useMemo(() => (source ? source.split(/\s+/).filter(Boolean).length : 0), [source]);
  useEffect(
    () => setWindowStatus(win.id, source === null ? null : { label: `${words.toLocaleString()} words`, key: "words" }),
    [win.id, words, source === null],
  );
  useEffect(() => () => setWindowStatus(win.id, null), [win.id]);
  useEffect(
    () => registerWindowActions(win.id, { openExternally: () => cmd.openPath(file) }),
    [win.id, file],
  );

  return (
    <div className="markdown-scroll" ref={scroller} tabIndex={0} onClick={onClick}>
      {error ? <div className="file-error">{error}</div> : <article className="markdown" ref={body} />}
    </div>
  );
}
