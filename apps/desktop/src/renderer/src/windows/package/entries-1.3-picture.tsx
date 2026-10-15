// API 1.3's Picture (protocol widget-elements-1.3-picture.ts), drawn by the kit's Picture in a
// box. Its src is only ever a data: image here: the core resolved an https one (fetched within
// the package's grant) before the tree left it, and the sanitiser (tree.ts) drops any other;
// so the page never loads a picture a widget names. Translated for the defaults the kit leaves
// open (a 64 px box) and the press.

import { Picture } from "@cmd/ui";
import type { ApiElement } from "@cmd/protocol";
import type { ComponentType } from "react";
import { press, str, v, type Drawn } from "./draw.ts";

function PictureEntry({ p, ctx }: Drawn) {
  return <Picture src={str(p.src) ?? null} alt={str(p.alt) ?? ""} fit={v<"cover" | "contain">(p.fit)} ratio={v<number>(p.ratio)} size={v<number | "fill">(p.size) ?? 64} radius={v<"sm" | "md" | "none">(p.radius)} icon={str(p.icon)} onClick={press(ctx, p.onClick, "onClick")} />;
}

/** The 1.3 Picture, and what draws it. */
export type TranslatedPicture = "Picture";
export const ENTRIES_1_3_PICTURE: { readonly [K in TranslatedPicture & ApiElement]: ComponentType<Drawn> } = {
  Picture: PictureEntry,
};
