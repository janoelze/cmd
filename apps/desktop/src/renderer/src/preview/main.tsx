// The page Magic's previews of widget packages are drawn in (docs/56, "Magic on V3";
// core magic/package/preview.ts): the main process (main/preview.ts) or Playwright loads it
// in an offscreen window with no preload and no network, and calls window.__cmdPreview with a
// tree: the wire messages a widget sent against the fake host, its title and icon, a theme.
// The tree is drawn by the package view, as the app draws a package window, in a window
// frame with its title bar; then the page says what it drew (errors, how much text and how
// many elements, whether it overflows) for the core to judge and screenshot. No widget code
// runs here: a tree is data, and the element table's allow-list is the renderer's own.

// This module only puts the stand-in bridge in place (bridge-stub.ts) before anything that
// subscribes to the core loads: draw.tsx comes after, as a module of its own.

import "./bridge-stub.ts";

await import("./draw.tsx");
