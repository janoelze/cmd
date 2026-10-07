// An empty space's hint: cycles through a few shortcuts worth knowing, as
// "Press ⌘K for the command palette". Commands are listed by id with the phrase
// that follows their keys; keys come from the user's keybindings, so a remap
// shows here and an unbound command is skipped.

import { useEffect, useState } from "react";
import { Kbd } from "@cmd/ui";
import { prettyAccelerator, type CommandId } from "../../../shared/commands.ts";
import { useKeybindings } from "../keybindings.ts";

const TIPS: [CommandId, string][] = [
  ["view.palette", "for the command palette"],
  ["file.new", "to open a window or widget"],
  ["file.newTerminal", "for a new terminal"],
  ["file.newClaude", "to start a Claude session"],
  ["view.search", "to search windows and past sessions"],
  ["file.openSpace", "to open a folder as a Space"],
  ["app.settings", "for settings"],
];
const EVERY_MS = 4000;

export function ShortcutTips() {
  const { bindings } = useKeybindings();
  const tips = TIPS.flatMap(([id, phrase]) => {
    const keys = prettyAccelerator(bindings[id]?.[0]);
    return keys ? [{ id, keys, phrase }] : [];
  });
  const [i, setI] = useState(0);
  useEffect(() => {
    if (tips.length < 2) return;
    const t = setInterval(() => setI((n) => n + 1), EVERY_MS);
    return () => clearInterval(t);
  }, [tips.length]);

  const tip = tips[i % Math.max(1, tips.length)];
  if (!tip) return null;
  return (
    <div className="shortcut-tip" key={i} style={tips.length > 1 ? { animationDuration: `${EVERY_MS}ms` } : { animation: "none" }} aria-live="polite">
      Press <Kbd keys={tip.keys} /> {tip.phrase}
    </div>
  );
}
