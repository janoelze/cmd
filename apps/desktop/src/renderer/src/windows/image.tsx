// Image window type (renderer half): title fields, menu, ⌘E between an SVG and
// its source, and Copy Image. The view itself (image-view.tsx) loads on first use.

import { toast } from "@cmd/ui";
import { cmd } from "../bridge.ts";
import { copy } from "../actions.ts";
import { shortPath } from "../model.ts";
import { fileUrl } from "../pdf/lib.ts";
import { lazyView, registerWindowView, stateStr } from "./registry.ts";
import { registerPreview, togglePreview } from "./preview.ts";

const dirOf = (p: string) => p.split("/").slice(0, -1).join("/") || "/";

/** The image as a PNG on the clipboard (the clipboard takes PNG only; an SVG is drawn at its size). */
export async function copyImageFile(path: string): Promise<void> {
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = fileUrl(path);
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("nothing to copy");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("Image copied");
  } catch {
    toast("Couldn't copy the image. Open it with the default app to copy it from there.", { tone: "danger" });
  }
}

// ⌘E shows an SVG's source in the editor, and back.
registerPreview("image", /\.svg$/i);

registerWindowView({
  kind: "image",
  View: lazyView(() => import("./image-view.tsx").then((m) => m.ImageView)),
  describe: (w) => ({ place: shortPath(dirOf(stateStr(w, "path") ?? "")) }),
  menu: (w) => {
    const p = stateStr(w, "path");
    const zoom = w.state.zoom;
    const set = (zoom: "fit" | number) => void cmd.call("window.update", { id: w.id, state: { zoom } }).catch(() => {});
    return [
      { label: "Fit", checked: zoom === "fit" || zoom === undefined, run: () => set("fit") },
      { label: "Actual Size", checked: zoom === 1, run: () => set(1) },
      "-",
      ...(p
        ? [
            ...(/\.svg$/i.test(p) ? [{ label: "Edit Source (⌘E)", run: () => togglePreview(w) }] : []),
            { label: "Copy Image", run: () => void copyImageFile(p) },
            { label: "Copy Path", run: () => copy(p) },
            { label: "Open with Default App", run: () => cmd.openPath(p) },
            { label: "Show in Finder", run: () => cmd.revealPath(p) },
          ]
        : []),
    ];
  },
});
