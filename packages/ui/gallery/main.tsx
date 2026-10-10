// The gallery's entry: the kit's styles, the built-in themes, tooltips and
// scrollbars, as the app's windows install them.

import { createRoot } from "react-dom/client";
import "../src/ui.css";
import "./gallery.css";
import "../src/themes/builtin.ts";
import { installScrollbars, installTooltips, Toaster } from "../src/index.ts";
import { Gallery } from "./Gallery.tsx";

installScrollbars();
installTooltips();
// The ErrorBoundary specimen throws on purpose; anything else a boundary catches is logged.
const onCaughtError = (err: unknown) => void (String(err).includes("on purpose") || console.error(err));
createRoot(document.getElementById("root")!, { onCaughtError }).render(
  <>
    <Gallery />
    <Toaster />
  </>,
);
