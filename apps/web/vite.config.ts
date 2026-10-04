// The remote-access web client (docs/13-remote-access.md): a static page served
// from its own origin, never the relay's. `pnpm web` serves it on localhost
// (a secure context, which WebCrypto needs); a phone needs it over HTTPS.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5180 },
  build: { outDir: "dist", target: "es2022" },
});
