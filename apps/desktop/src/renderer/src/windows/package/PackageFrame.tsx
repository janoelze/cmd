// A frame widget's content (docs/56, "The frame surface, for pixels"): a package widget with
// `"surface": "frame"` draws its view.html in the shared frame host (FrameHost.tsx). The core
// says what it may load (widget.frameSource: the package folder, the grant's hosts); the page
// loads again when the grant changes or the process restarts (a save, Restart).

import { useContext } from "react";
import { configValues, type AppWindow, type WidgetEntry } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import { PlacementContext } from "../registry.ts";
import { FrameHost } from "./FrameHost.tsx";

export function PackageFrame({ win, entry, active, reload }: { win: AppWindow; entry: WidgetEntry | undefined; active: boolean; reload: number }) {
  const placement = useContext(PlacementContext);
  const grant = JSON.stringify(entry?.ask ?? null) + JSON.stringify(entry?.permissions ?? null);
  return (
    <FrameHost
      windowId={win.id}
      title={win.title}
      serve={(init) => servePage(win.id, "view.html", init)}
      reloadKey={`${win.id}\n${grant}\n${reload}`}
      active={active}
      kv={(win.state.kv as Record<string, unknown> | undefined) ?? {}}
      config={configOf(entry, win)}
      placement={placement}
    />
  );
}

/** A page of the window's package, served for a frame (null before the grant, or for a window that draws none). */
export async function servePage(windowId: string, page: string, init: Parameters<typeof cmd.packageFrame>[0]["init"]): Promise<string | null> {
  const s = await cmd.call("widget.frameSource", { windowId });
  return s ? cmd.packageFrame({ dir: s.dir, page, media: s.media, init }) : null;
}

/** The window's config as the page sees it: the manifest's defaults, then the person's values; never a secret. */
export const configOf = (entry: WidgetEntry | undefined, win: AppWindow): Record<string, unknown> => configValues(entry?.config, win.state.config as Record<string, unknown> | undefined);
