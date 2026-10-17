// A browser window's DevTools (docs/59): Chromium's own front end in a <webview> of the inspector
// session, which main connects to the page (main/inspector.ts). Shown by an Inspector window, and
// beside the page by a browser window that has it inside. When the page moves to another guest
// (docking re-attaches a webview), main says so and the front end reloads, which reconnects it.

import { useEffect, useRef, useState } from "react";
import type { WebviewTag } from "electron";
import type { WindowId } from "@cmd/protocol";
import { WebStage } from "@cmd/ui";
import { onThemeChange } from "@cmd/ui/themes";
import { cmd } from "../../lib/bridge.ts";
import { handleEmbedMessage } from "../../lib/embed.ts";
import { devtoolsThemeCss } from "./devtoolsTheme.ts";

/** The inspector session (main/web-policy.ts INSPECTOR_PARTITION): only DevTools runs there. */
const PARTITION = "persist:cmd-inspector";

export function InspectorFrame({ forId }: { forId: WindowId }) {
  const ref = useRef<WebviewTag | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    cmd.inspectorUrl(forId).then(
      (u) => live && setUrl(u),
      () => live && setFailed(true),
    );
    return () => void (live = false);
  }, [forId]);

  useEffect(
    () =>
      cmd.onInspectorTarget((id) => {
        if (id !== forId) return;
        try {
          ref.current?.reload();
        } catch {
          // not attached yet: it connects to the new page when it loads
        }
      }),
    [forId],
  );

  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    // The theme goes in with every load (a reload drops it), then follows the app's.
    let themed: Promise<string | null> = Promise.resolve(null);
    const theme = () => {
      const css = devtoolsThemeCss();
      themed = themed.then((key) => (key ? wv.removeInsertedCSS(key).catch(() => {}) : undefined)).then(() => wv.insertCSS(css).catch(() => null));
    };
    const ready = () => {
      themed = Promise.resolve(null);
      theme();
      void themed.then(() => wv.setAttribute("data-painted", ""));
    };
    const offTheme = onThemeChange(theme);
    // Presses in DevTools select its window, as in any page (preload/guest.ts).
    const reported = (e: { channel: string; args: unknown[] }) => {
      if (e.channel === "cmd-embed") handleEmbedMessage(wv as unknown as HTMLElement, e.args[0]);
    };
    wv.addEventListener("dom-ready", ready);
    wv.addEventListener("ipc-message", reported as never);
    return () => {
      offTheme();
      wv.removeEventListener("dom-ready", ready);
      wv.removeEventListener("ipc-message", reported as never);
    };
  }, [url]);

  return (
    <WebStage cover={failed ? { kind: "error", title: "Inspector Didn't Start", text: "cmd couldn't connect DevTools to this page. Close the inspector and try again." } : null}>
      {url && <webview ref={ref as never} data-embed data-inspector src={url} partition={PARTITION} />}
    </WebStage>
  );
}
