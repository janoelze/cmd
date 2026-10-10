// The Settings window (pnpm workbench settingswindow), on the Workbench's own
// core: its real settings, at the window's default and smallest sizes, and the
// pages drawn by hand (Browser, shortcuts, Remote Access, About).

import { Window, WindowBody, WindowFrame } from "@cmd/ui";
import type { ReactNode } from "react";
import { SettingsWindow } from "./SettingsWindow.tsx";

/** The window's page at a size (main's openSettings: 860×620, at least 700×440), opened at a page. */
function Frame({ width = 860, height = 620, page = "appearance" }: { width?: number; height?: number; page?: string }): ReactNode {
  // SettingsWindow opens at the page it last showed.
  try {
    localStorage.setItem("settings.page", page);
  } catch {}
  return (
    <Window selected style={{ width, height, position: "relative", flex: "none" }}>
      <WindowBody style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <SettingsWindow key={page} />
      </WindowBody>
      <WindowFrame />
    </Window>
  );
}

export const Default = () => <Frame />;
export const Smallest = () => <Frame width={700} height={440} />;
export const Shortcuts = () => <Frame page="keyboard" />;
export const Remote = () => <Frame page="remote" />;
export const About = () => <Frame page="about" />;
export const Data = () => <Frame page="data" />;
export const Browser = () => <Frame page="browser" />;
