// The preview page's drawing (main.tsx loads it once the page's stand-in bridge is in place):
// window.__cmdPreview draws a tree in a widget window and measures what it drew.

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import "@cmd/ui/ui.css";
import "../styles.css";
import "./preview.css";
import { UIProvider, Window as Frame, WindowBar, WindowBody, WindowFrame } from "@cmd/ui";
import "@cmd/ui/themes/builtin";
import { allThemes, applyTheme, themeFor } from "@cmd/ui/themes";
import type { MagicPreviewTree } from "@cmd/protocol";
import { useWindowStatus } from "../lib/windowActions.ts";
import { useWindowChrome } from "../windows/registry.ts";
import { PackageWidget } from "../windows/package/PackageView.tsx";
import type { WidgetLink } from "../windows/package/live.ts";
import { TreeStore } from "../windows/package/tree.ts";

declare global {
  interface Window {
    __cmdPreview(tree: MagicPreviewTree): Promise<Measured>;
    /** Every theme's id, in the Settings order (`cmd widget preview --themes all`). */
    __cmdPreviewThemes(): string[];
  }
}

interface Measured {
  errors: string[];
  text: number;
  nodes: number;
  drawn: boolean;
  scrollW: number;
  scrollH: number;
}

const ID = "preview";
const quiet: WidgetLink = { interact: () => {}, resync: () => {}, restart: () => {}, env: () => {}, ask: () => {} };
const errors: string[] = [];
window.addEventListener("error", (e) => errors.push(e.message));
const warn = console.warn.bind(console);
// The tree's own complaints (an element outside the allow-list, a prop dropped) are what the agent should hear.
console.warn = (...a: unknown[]) => (errors.push(a.map(String).join(" ")), warn(...a));

function Bar({ title, icon }: { title: string; icon: string }) {
  useWindowChrome();
  const status = useWindowStatus(ID);
  return (
    <WindowBar icon={icon} name={title}>
      <span className="ui-window-bar-meta">{status?.label}</span>
    </WindowBar>
  );
}

const root = createRoot(document.getElementById("root")!);
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

window.__cmdPreviewThemes = () => allThemes().map((t) => t.id);

window.__cmdPreview = async (tree) => {
  errors.length = 0;
  const theme = themeFor(tree.theme);
  if (theme) applyTheme(theme);
  const store = new TreeStore({ resync: () => {} });
  for (const m of tree.messages) store.apply(m);
  flushSync(() =>
    root.render(
      <UIProvider>
        <Frame selected className="tree-preview-window">
          <WindowBody className="tree-preview-body">
            <Bar title={tree.title} icon={tree.icon} />
            <div className="tree-preview-content">
              <PackageWidget windowId={ID} store={store} link={quiet} />
            </div>
          </WindowBody>
          <WindowFrame />
        </Frame>
      </UIProvider>,
    ),
  );
  await frame();
  await frame();
  await new Promise((r) => setTimeout(r, 150));
  const content = document.querySelector(".tree-preview-content") as HTMLElement | null;
  return {
    errors: [...errors],
    text: (content?.innerText ?? "").trim().length,
    nodes: content?.querySelectorAll("*").length ?? 0,
    drawn: !!content?.querySelector("svg, canvas"),
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
  };
};
