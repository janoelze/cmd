// Preload for browser windows' pages (<webview> guests), set by the main
// process (will-attach-webview). It runs in an isolated world, so the page can
// neither see nor tamper with it, and has no Node or app API: it only reports,
// through Electron's host channel, the input the app can't see for an embedded
// page (renderer/src/embed.ts): presses, so the window gets selected, and
// sideways scrolls the page doesn't use itself, so the strip scrolls.

import { ipcRenderer } from "electron";
import { sidewaysForApp } from "../shared/embed-input.ts";

const send = (m: unknown) => ipcRenderer.sendToHost("cmd-embed", m);

window.addEventListener(
  "pointerdown",
  (e) => {
    if (e.button === 0) send({ type: "press" });
  },
  { capture: true, passive: true },
);

window.addEventListener(
  "wheel",
  (e) => {
    if (!sidewaysForApp(e)) return;
    e.preventDefault();
    send({ type: "wheel", deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, x: e.clientX, y: e.clientY });
  },
  { capture: true, passive: false },
);
