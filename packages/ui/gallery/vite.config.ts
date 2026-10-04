// The gallery: every @cmd/ui component in every theme, in a browser
// (pnpm ui). `?theme=<id>&page=<id>` opens a theme and page directly, which
// the screenshot script (gallery/shots.mjs) uses.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { port: 5190 },
  build: { outDir: "dist", emptyOutDir: true },
});
