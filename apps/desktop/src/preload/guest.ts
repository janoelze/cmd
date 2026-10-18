// Preload for browser windows' pages (<webview> guests), set by the main
// process (will-attach-webview). It runs in an isolated world, so the page can
// neither see nor tamper with it, and has no Node or app API: it only reports,
// through Electron's host channel, the input the app can't see for an embedded
// page (renderer/src/lib/embed.ts): presses, so the window gets selected; and to main,
// where a right-click landed, for Inspect Element (main/page-menu.ts). Sideways
// scrolls need nothing: Chromium bubbles what the page doesn't use into the
// strip. No wheel listener here, so the page scrolls on its compositor thread.

import { ipcRenderer } from "electron";

const send = (m: unknown) => ipcRenderer.sendToHost("cmd-embed", m);

window.addEventListener(
  "pointerdown",
  (e) => {
    // Only the person's own presses: a page can dispatch synthetic ones.
    if (!e.isTrusted) return;
    if (e.button === 0) send({ type: "press" });
  },
  { capture: true, passive: true },
);

// In the page's CSS pixels, before Electron's context-menu event reaches main (both go over
// the frame's channel, in order); its own x and y aren't reliably the page's.
window.addEventListener(
  "contextmenu",
  (e) => {
    if (e.isTrusted) ipcRenderer.send("page-context-point", e.clientX, e.clientY);
  },
  { capture: true, passive: true },
);
