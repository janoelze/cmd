// Workbench stories (pnpm workbench imageview): the Image window on real files, read
// by the real core: a screenshot fit to the window, at actual size, a file that isn't
// an image, and every size.

import { AllSizes, RefWindow, type SizeName } from "../reference/RefWindow.tsx";
import { storyWindow, useRepoFile } from "../reference/RepoFile.tsx";
import { ImageView } from "./image-view.tsx";

function Img({ rel = "docs/screenshots/hero-dark.png", size = "wide", zoom }: { rel?: string; size?: SizeName; zoom?: "fit" | number }) {
  const path = useRepoFile(rel);
  return (
    <RefWindow icon="photo" name={rel.split("/").pop()!} size={size}>
      {path && <ImageView win={storyWindow("image", { path, zoom })} focused={false} />}
    </RefWindow>
  );
}

export const Fit = () => <Img />;
export const ActualSize = () => <Img zoom={1} />;
export const NotAnImage = () => <Img rel="README.md" />;
export const Sizes = () => <AllSizes render={(s) => <Img size={s} />} />;
