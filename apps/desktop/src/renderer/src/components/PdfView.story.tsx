// Workbench stories (pnpm workbench pdfview): the PDF window on a real file (a
// six-page fixture with an outline), read by the real core: pages, the thumbnails
// sidebar, the outline, dark pages, a file that isn't a PDF, and every size.

import { AllSizes, RefWindow, type SizeName } from "../reference/RefWindow.tsx";
import { storyWindow, useRepoFile } from "../reference/RepoFile.tsx";
import { PdfView } from "./PdfView.tsx";

const FIXTURE = "apps/desktop/src/renderer/src/reference/fixtures/manual.pdf";

function Pdf({ rel = FIXTURE, size = "wide", state = {} }: { rel?: string; size?: SizeName; state?: Record<string, unknown> }) {
  const path = useRepoFile(rel);
  return (
    <RefWindow icon="doc.richtext" name={rel.split("/").pop()!} size={size}>
      {path && <PdfView win={storyWindow("pdf", { path, ...state })} focused={false} />}
    </RefWindow>
  );
}

export const Pages = () => <Pdf />;
export const Thumbnails = () => <Pdf state={{ sidebar: "pages" }} />;
export const Outline = () => <Pdf state={{ sidebar: "outline" }} />;
export const DarkPages = () => <Pdf state={{ dark: true }} />;
export const NotAPdf = () => <Pdf rel="README.md" />;
export const Sizes = () => <AllSizes render={(s) => <Pdf size={s} state={{ sidebar: "pages" }} />} />;
