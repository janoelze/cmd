// The Space switcher at the bottom of the sidebar (docs/11-spaces.md): the shown Space by
// name, the other open Spaces as colored dots in switcher order (⌃1–9), each
// marked when something in it needs you or finished unseen. Hovering a dot
// labels it at once (the native title tooltip is too slow to switch by).

import { useLayoutEffect, useRef, useState } from "react";
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
  const [tip, setTip] = useState<{ id: SpaceId; rect: DOMRect } | null>(null);
  const hide = () => setTip(null);
  const tipped = tip && p.spaces.find((sp) => sp.id === tip.id);
  return (
    <div className="spacebar" role="tablist" aria-label="Spaces" onPointerLeave={hide}>
      {p.spaces.map((sp, i) => {
        const on = sp.id === p.current;
        const attn = p.attention.get(sp.id);
        const show = (e: React.SyntheticEvent<HTMLElement>) => setTip({ id: sp.id, rect: e.currentTarget.getBoundingClientRect() });
        return (
          <button
            key={sp.id}
            role="tab"
            aria-selected={on}
            aria-label={sp.name}
            className={`space-chip ${on ? "on" : ""} ${attn ? `attn-${attn}` : ""}`}
            style={{ ["--hue" as string]: sp.hue }}
            onClick={() => (hide(), on ? p.onPicker() : p.onShow(sp.id))}
            onContextMenu={(e) => (e.preventDefault(), hide(), p.onMenu(sp))}
            onPointerEnter={show}
            onFocus={show}
            onBlur={hide}
          >
            <span className="space-dot" />
            {/* Always there, so switching can animate it open and closed. */}
            <span className="space-name" aria-hidden={!on}>
              {sp.name}
            </span>
          </button>
        );
      })}
      {tip && tipped && (
        <SpaceTip
          space={tipped}
          rect={tip.rect}
          shown={tipped.id === p.current}
          attention={p.attention.get(tipped.id)}
          shortcut={p.spaces.indexOf(tipped) < 9 ? `⌃${p.spaces.indexOf(tipped) + 1}` : null}
        />
      )}
    </div>
  );
}

/** The hovered chip's label: above it (or below, in the titlebar), kept inside the window. */
function SpaceTip(p: { space: Space; rect: DOMRect; shown: boolean; attention?: "needs" | "unseen"; shortcut: string | null }) {
  const el = useRef<HTMLDivElement>(null);
  const below = p.rect.top < 80;
  const [left, setLeft] = useState(p.rect.left + p.rect.width / 2);
  useLayoutEffect(() => {
    const w = el.current?.offsetWidth ?? 0;
    const center = p.rect.left + p.rect.width / 2;
    setLeft(Math.max(8 + w / 2, Math.min(window.innerWidth - 8 - w / 2, center)));
  }, [p.rect, p.space.name]);
  return (
    <div
      ref={el}
      className={`space-tip ${below ? "below" : ""}`}
      role="tooltip"
      style={{ left, top: below ? p.rect.bottom + 6 : p.rect.top - 6, ["--hue" as string]: p.space.hue }}
    >
      <div className="space-tip-title">
        <span className="space-dot" />
        <span className="space-tip-name">{p.space.name}</span>
        <kbd>{p.shown ? "⌘O" : p.shortcut}</kbd>
      </div>
      <div className="space-tip-meta">
        {shortPath(p.space.root)}
        {p.attention === "needs" ? " · needs you" : p.attention === "unseen" ? " · done" : ""}
      </div>
    </div>
  );
}
