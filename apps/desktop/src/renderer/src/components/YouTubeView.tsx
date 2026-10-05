// YouTube, a built-in widget (docs/16-widgets.md): a player filling the window.
// Empty, it asks for a link, video id or embed code (the core parses it,
// youtubeType). The player is YouTube's embed page in a <webview>, not an
// iframe: the app's CSP allows no web frames, and YouTube refuses embeds that
// send no Referer (error 153), which a webview can set (httpreferrer). Its
// Sign in (YouTube's "not a bot" check) opens a browser window, same session;
// the player reloads once YouTube's sign-in cookie is set (main: SIGN_IN_COOKIES).

import { useEffect, useRef, useState } from "react";
import type { WebviewTag } from "electron";
import { EmptyState, TextField } from "@cmd/ui";
import { cmd } from "../bridge.ts";
import { handleEmbedMessage } from "../embed.ts";
import { POPUPS } from "./BrowserView.tsx";
import type { WindowViewProps } from "../windows/registry.ts";
import "./widgets.css";

/** Who the player is embedded by, as YouTube asks of embeds. */
const REFERRER = "https://github.com/janoelze/cmd";

type Ref = { video?: string; list?: string; start?: number };

/** Fill: the video covers the player, cropped, instead of fitting with bars (YouTube sizes it inline). */
const FILL_CSS = `.html5-video-player .html5-video-container { position: absolute !important; inset: 0 !important; } .html5-video-player video.video-stream { left: 0 !important; top: 0 !important; width: 100% !important; height: 100% !important; object-fit: cover !important; }`;

const refOf = (state: Record<string, unknown>): Ref => ({
  video: typeof state.video === "string" ? state.video : undefined,
  list: typeof state.list === "string" ? state.list : undefined,
  start: typeof state.start === "number" ? state.start : undefined,
});

/**
 * The embed page for a video and/or playlist. youtube.com, not the
 * youtube-nocookie.com one: YouTube asks signed-out players to sign in ("not a
 * bot"), and only youtube.com sees the sign-in (the browser windows' session).
 */
export function embedUrl(r: Ref): string {
  const q = new URLSearchParams({ rel: "0", playsinline: "1" });
  if (r.list) q.set("list", r.list);
  if (r.start) q.set("start", String(r.start));
  return `https://www.youtube.com/embed/${r.video ?? "videoseries"}?${q}`;
}

/** The video's page on youtube.com (Open on YouTube, Copy Link). */
export function watchUrl(r: Ref): string | undefined {
  if (!r.video && !r.list) return undefined;
  const q = new URLSearchParams();
  if (r.video) q.set("v", r.video);
  if (r.list) q.set("list", r.list);
  if (r.start) q.set("t", `${r.start}s`);
  return `https://www.youtube.com/${r.video ? "watch" : "playlist"}?${q}`;
}

export function YouTubeView({ win, focused }: WindowViewProps) {
  const r = refOf(win.state);
  const src = r.video || r.list ? embedUrl(r) : null;
  return src ? <Player key={src} id={win.id} src={src} fill={win.state.fill === true} /> : <Ask id={win.id} focused={focused} />;
}

function Player({ id, src, fill }: { id: string; src: string; fill: boolean }) {
  const ref = useRef<WebviewTag | null>(null);
  // Bumped on every page load (dom-ready), which drops injected CSS.
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    const wv = ref.current;
    if (!wv || !loads || !fill) return;
    const key = wv.insertCSS(FILL_CSS).catch(() => "");
    return () => {
      void key.then((k) => {
        if (k) wv.removeInsertedCSS(k).catch(() => {});
      });
    };
  }, [fill, loads]);
  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    // The embed page is titled "<video> - YouTube": the window takes the video's name.
    const titled = (e: { title: string }) => {
      const t = e.title.replace(/\s+-\s+YouTube$/, "").trim();
      if (t && t !== "YouTube") void cmd.call("window.update", { id, title: t }).catch(() => {});
    };
    const reported = (e: { channel: string; args: unknown[] }) => {
      if (e.channel === "cmd-embed") handleEmbedMessage(wv as unknown as HTMLElement, e.args[0]);
    };
    const ready = () => setLoads((n) => n + 1);
    // Signed in (in a browser window or a pop-up): the "not a bot" wall goes away on a reload.
    const offSignedIn = cmd.onSignedIn((site) => site === "youtube.com" && wv.reload());
    wv.addEventListener("page-title-updated", titled as never);
    wv.addEventListener("ipc-message", reported as never);
    wv.addEventListener("dom-ready", ready);
    return () => {
      offSignedIn();
      wv.removeEventListener("dom-ready", ready);
      wv.removeEventListener("page-title-updated", titled as never);
      wv.removeEventListener("ipc-message", reported as never);
    };
  }, [id]);
  return (
    <div className="yt">
      <webview ref={ref as never} className="yt-player" data-embed src={src} httpreferrer={REFERRER} partition="persist:cmd-browser" allowpopups={POPUPS} />
    </div>
  );
}

function Ask({ id, focused }: { id: string; focused: boolean }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focused) input.current?.focus();
  }, [focused]);

  const submit = (v: string) => {
    if (!v.trim()) return;
    cmd.call("window.update", { id, state: { input: v } }).catch(() => setError("That isn't a YouTube link, video id or embed code."));
  };
  return (
    <div className="yt yt-ask">
      <EmptyState icon="play.rectangle" title="YouTube">
        <div className="yt-field">
          <TextField
            ref={input}
            fill
            value={text}
            invalid={!!error}
            placeholder="Paste a link, video id or embed code"
            onChange={(v) => (setText(v), setError(null))}
            onKeyDown={(e) => e.key === "Enter" && submit(text)}
            onPaste={(e) => submit(e.clipboardData.getData("text"))}
          />
          {error && <div className="yt-error">{error}</div>}
        </div>
      </EmptyState>
    </div>
  );
}
