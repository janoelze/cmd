// The "jam" view, Jam: music as code (components/JamView.tsx, loaded on first
// use). Its menu plays, stops, asks the AI for a change and opens a Visualizer
// that listens to it; the view registers what those do for its window here.

import type { AppWindow } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import type { MenuEntry } from "../context.ts";
import { lazyView, registerWindowView } from "./registry.ts";

export const jamControls = new Map<string, { play(): void; stop(): void; ask(): void; save(): void }>();

function menu(w: AppWindow): MenuEntry[] {
  const c = () => jamControls.get(w.id);
  return [
    { label: "Play", run: () => c()?.play() },
    { label: "Stop", run: () => c()?.stop() },
    { label: "Ask for a Change…", run: () => c()?.ask() },
    { label: w.state.path ? "Save" : "Save…", run: () => c()?.save() },
    "-",
    { label: "Open Visualizer", run: () => void cmd.call("window.open", { kind: "visualizer", input: { source: `window:${w.id}` }, workspaceId: w.workspaceId }).catch(() => {}) },
  ];
}

registerWindowView({
  kind: "jam",
  View: lazyView(() => import("../components/JamView.tsx").then((m) => m.JamView)),
  describe: () => ({ kind: null }),
  menu,
});
