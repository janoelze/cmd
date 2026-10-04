// The remote-access web client (docs/13-remote-access.md): a prototype that
// pairs with a Mac and shows its terminals and agents, end-to-end encrypted.

import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
