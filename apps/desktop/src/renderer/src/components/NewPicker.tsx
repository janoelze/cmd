// New… (⌘N, the top bar's +): one picker for every new window and widget
// (renderer/src/newItems.ts), in the command palette's frame.

import { toast } from "@cmd/ui";
import type { CommandId } from "../../../shared/commands.ts";
import { addWidget, newMagic } from "../actions.ts";
import { useKeybindings } from "../keybindings.ts";
import { magicItem, NEW_GROUPS, newItems, openItems } from "../newItems.ts";
import { useStoreValue } from "../store.ts";
import { Palette } from "./Palette.tsx";

export function NewPicker({ run, onClose, closing }: { run: (id: CommandId) => void; onClose: () => void; closing?: boolean }) {
  const library = useStoreValue((s) => s.library);
  const keys = useKeybindings();
  const add = (ref: string) => void addWidget(ref).catch((e: Error) => toast(e.message, { tone: "danger" }));
  return (
    <Palette
      label="New"
      items={newItems(library, keys.bindings, run, add)}
      groups={NEW_GROUPS}
      dynamic={(q) => openItems(q, "Open", { icon: true })}
      fallback={(q) => magicItem(q, keys.bindings, (prompt) => void newMagic(prompt))}
      onClose={onClose}
      closing={closing}
      placeholder="Open a window or widget, or type a URL or path"
      footer={
        <>
          <span>
            <kbd>↑↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
        </>
      }
    />
  );
}
