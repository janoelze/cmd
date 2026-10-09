// Workbench stories (pnpm workbench pdfview): the PDF window on a real file (a
// fixture of several pages), read by the real core: its pages, dark pages, a file
// that isn't a PDF, and every size.

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
export const DarkPages = () => <Pdf state={{ dark: true }} />;
export const NotAPdf = () => <Pdf rel="README.md" />;
export const Sizes = () => <AllSizes render={(s) => <Pdf size={s} />} />;
