// An empty space's hint: cycles through a few shortcuts worth knowing. Commands
// are listed by id; labels and keys come from the command list and the user's
// keybindings, so a remap shows here and an unbound command is skipped.

import { useEffect, useState } from "react";
import { Kbd } from "@cmd/ui";
import { COMMAND_BY_ID, prettyAccelerator } from "../../../shared/commands.ts";
import { useKeybindings } from "../keybindings.ts";

const TIPS = ["view.palette", "file.new", "file.newTerminal", "file.newClaude", "view.search", "file.openSpace", "app.settings"];
const EVERY_MS = 4000;

export function ShortcutTips() {
  const { bindings } = useKeybindings();
  const tips = TIPS.flatMap((id) => {
    const keys = prettyAccelerator(bindings[id]?.[0]);
    const label = COMMAND_BY_ID.get(id)?.label.replace(/…$/, "");
    return keys && label ? [{ id, keys, label }] : [];
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
    <div className="shortcut-tip" key={tip.id} aria-live="polite">
      <Kbd keys={tip.keys} />
      <span>{tip.label}</span>
    </div>
  );
}
