// Before pdf_viewer.mjs loads (lib.ts): the library on globalThis, and its worker.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

(globalThis as { pdfjsLib?: typeof pdfjs }).pdfjsLib = pdfjs;
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
