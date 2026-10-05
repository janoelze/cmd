// pdf.js, set up once: the library, its worker, and the viewer components
// (pdf_viewer.mjs reads the library from globalThis.pdfjsLib when it loads, so
// setup.ts, imported first, puts it there). Loaded only with a PDF window
// (windows/builtin.tsx lazyView), so none of it is in the startup bundle.

import "./setup.ts";
import * as pdfjs from "pdfjs-dist";
import { EventBus, FindState, LinkTarget, PDFFindController, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";

export { pdfjs, EventBus, FindState, LinkTarget, PDFFindController, PDFLinkService, PDFViewer };

/** What pdf.js fetches for some PDFs (electron.vite.config.ts pdfjsAssets). */
const asset = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;
export const ASSETS = { cMapUrl: asset("cmaps"), cMapPacked: true, standardFontDataUrl: asset("standard_fonts"), wasmUrl: asset("wasm"), iccUrl: asset("iccs") };

/** The app's read-only file protocol (main/index.ts), with a token so a reload isn't served from cache. */
export const fileUrl = (p: string) => `cmd-file://local/?path=${encodeURIComponent(p)}&t=${Date.now()}`;
