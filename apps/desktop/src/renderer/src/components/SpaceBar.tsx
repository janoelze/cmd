// The Space switcher at the bottom of the sidebar (docs/11-spaces.md): the shown Space by
// name, the other open Spaces as colored dots in switcher order (⌃1–9), each
// marked when something in it needs you or finished unseen.

import type { Space, SpaceId } from "@cmd/protocol";
import { shortPath } from "../model.ts";

interface Props {
  spaces: Space[];
  current: SpaceId;
  attention: Map<SpaceId, "needs" | "unseen">;
  onShow: (id: SpaceId) => void;
  onMenu: (space: Space) => void;
  /** The shown Space's name opens the Space picker (⌘O). */
  onPicker: () => void;
}

export function SpaceBar(p: Props) {
  return (
    <div className="spacebar" role="tablist" aria-label="Spaces">
      {p.spaces.map((sp, i) => {
        const on = sp.id === p.current;
        const attn = p.attention.get(sp.id);
        const key = i < 9 ? ` — ⌃${i + 1}` : "";
        return (
          <button
            key={sp.id}
            role="tab"
            aria-selected={on}
            className={`space-chip ${on ? "on" : ""} ${attn ? `attn-${attn}` : ""}`}
            style={{ ["--hue" as string]: sp.hue }}
            title={on ? `${shortPath(sp.root)} — Open Space… ⌘O` : `${sp.name} (${shortPath(sp.root)})${key}`}
            onClick={() => (on ? p.onPicker() : p.onShow(sp.id))}
            onContextMenu={(e) => (e.preventDefault(), p.onMenu(sp))}
          >
            <span className="space-dot" />
            {/* Always there, so switching can animate it open and closed. */}
            <span className="space-name" aria-hidden={!on}>
              {sp.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}
