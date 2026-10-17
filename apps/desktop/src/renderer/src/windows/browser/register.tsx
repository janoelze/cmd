// Browser windows (renderer half): the title (the page's, else its host) and right-click's Device Size, Inspector (docs/59), Open in Default Browser and Copy URL.

import type { AppWindow } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import type { MenuEntry } from "../../lib/context.ts";
import { copy } from "../../lib/actions.ts";
import { hostOf } from "../../lib/model.ts";
import { BrowserView } from "./BrowserView.tsx";
import { DEVICES } from "./devices.ts";
import { registerWindowView, stateStr } from "../registry.ts";
import { closeInspector, hasPage, inspectorPlace, openInspector } from "../inspector/open.ts";

/** Right-click → Device Size: show the page at a phone's, tablet's or desktop's size. */
function deviceMenu(w: AppWindow): MenuEntry {
  const current = stateStr(w, "device");
  const pick = (device: string | null) => () => void cmd.call("window.update", { id: w.id, state: { device } }).catch(() => {});
  return {
    label: "Device Size",
    submenu: [
      { label: "Fit Window", checked: !current, run: pick(null) },
      ...DEVICES.flatMap((group): MenuEntry[] => [
        "-",
        ...group.map((d) => ({ label: `${d.name}  ${d.width}×${d.height}`, checked: current === d.id, run: pick(d.id) })),
      ]),
    ],
  };
}

/** Right-click → Open Inspector: DevTools in a new window beside the page, or inside this one. */
function inspectorMenu(w: AppWindow): MenuEntry {
  const at = inspectorPlace(w);
  const open = (where: "window" | "inside") => () => void openInspector(w, where).catch(() => {});
  return {
    label: at ? "Inspector" : "Open Inspector",
    enabled: hasPage(w),
    submenu: [
      { label: "In New Window", checked: at === "window", run: open("window") },
      { label: "In This Window", checked: at === "inside", run: open("inside") },
      ...(at ? ["-" as const, { label: "Close Inspector", run: () => void closeInspector(w).catch(() => {}) }] : []),
    ],
  };
}

registerWindowView({
  kind: "browser",
  View: BrowserView,
  placeInToolbar: true,
  describe: (w) => {
    const url = stateStr(w, "url") ?? null;
    const host = hostOf(url).replace(/^www\./, "");
    return { name: (w.title && w.title !== url ? w.title : host) || "New Tab", place: host };
  },
  menu: (w) => {
    const url = stateStr(w, "url");
    return [
      deviceMenu(w),
      inspectorMenu(w),
      ...(url
        ? [
            "-" as const,
            { label: "Open in Default Browser", run: () => cmd.openPath(url, { from: "user" }) },
            { label: "Copy URL", run: () => copy(url) },
          ]
        : []),
    ];
  },
});
