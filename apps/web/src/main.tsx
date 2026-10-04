// The remote-access web client (docs/13-remote-access.md): a prototype that
// pairs with a Mac and shows its terminals and agents, end-to-end encrypted.

import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

// The app fills what's visible: on a phone that's above the keyboard. iOS
// shrinks the visual viewport (not the layout one) when the keyboard opens and
// may scroll it; following it keeps the bars in place and the page unscrolled.
const vv = window.visualViewport;
const follow = () => {
  const s = document.documentElement.style;
  s.setProperty("--app-h", `${vv ? vv.height : window.innerHeight}px`);
  s.setProperty("--app-top", `${vv ? vv.offsetTop : 0}px`);
};
vv?.addEventListener("resize", follow);
vv?.addEventListener("scroll", follow);
window.addEventListener("resize", follow);
follow();

createRoot(document.getElementById("root")!).render(<App />);
