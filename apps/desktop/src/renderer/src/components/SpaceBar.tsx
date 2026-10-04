// The Space switcher at the bottom of the sidebar (docs/11-spaces.md): a button
// with the shown Space's name that drops down a menu of the open Spaces in
// switcher order (⌃1–9), each with its folder and marked when something in it
// needs you or finished unseen. The button carries the same mark for the other
// Spaces, so a background Space that wants you shows without opening the menu.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Space, SpaceId } from "@cmd/protocol";
import { shortPath } from "../model.ts";
import { ICON, Symbol } from "./Symbol.tsx";

type Attention = "needs" | "unseen";

interface Props {
  spaces: Space[];
  current: SpaceId;
  attention: Map<SpaceId, Attention>;
  onShow: (id: SpaceId, opts?: { newWindow?: boolean }) => void;
  onMenu: (space: Space) => void;
  /** "Open Space…" at the end of the menu: the Space picker (⌘O). */
  onPicker: () => void;
}

export function SpaceBar(p: Props) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const shown = p.spaces.find((sp) => sp.id === p.current);
  // The strongest mark among the other Spaces, and how many have one.
  const others = p.spaces.filter((sp) => sp.id !== p.current && p.attention.has(sp.id));
  const mark: Attention | undefined = others.some((sp) => p.attention.get(sp.id) === "needs") ? "needs" : others.length ? "unseen" : undefined;
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  return (
    <div className="spacebar">
      <button
        ref={button}
        className={`space-trigger ${open ? "open" : ""}`}
        style={{ ["--hue" as string]: shown?.hue ?? 240 }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={shown ? shortPath(shown.root) : undefined}
        onClick={() => setOpen(!open)}
        onContextMenu={(e) => (e.preventDefault(), setOpen(false), shown && p.onMenu(shown))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") e.preventDefault(), setOpen(true);
        }}
      >
        <span className="space-dot" />
        <span className="space-name">{shown?.name ?? "—"}</span>
        {mark && (
          <span className={`space-badge attn-${mark}`} title={`${others.length} other Space${others.length === 1 ? "" : "s"} ${mark === "needs" ? "need you" : "finished"}`}>
            {others.length}
          </span>
        )}
        <Symbol name="chevron.up.chevron.down" size={ICON.disclosure} />
      </button>
      {open && button.current && <SpaceMenu {...p} anchor={button.current} onClose={close} />}
    </div>
  );
}

/** The dropped-down list: above the button and as wide (in the titlebar: below it), kept inside the window. */
function SpaceMenu(p: Props & { anchor: HTMLElement; onClose: (refocus: boolean) => void }) {
  const el = useRef<HTMLDivElement>(null);
  // Items: every open Space, then "Open Space…". Starts on the shown Space.
  const count = p.spaces.length + 1;
  const [active, setActive] = useState(() => Math.max(0, p.spaces.findIndex((sp) => sp.id === p.current)));
  const [pos, setPos] = useState<{ left: number; width?: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const typed = useRef({ text: "", at: 0 });

  useLayoutEffect(() => {
    const r = p.anchor.getBoundingClientRect();
    const below = r.top < 80;
    if (!below) return setPos({ left: r.left, width: r.width, bottom: window.innerHeight - r.top + 6, maxHeight: r.top - 20 });
    const w = el.current?.offsetWidth ?? 0;
    setPos({ left: Math.max(8, Math.min(window.innerWidth - 8 - w, r.left)), top: r.bottom + 6, maxHeight: window.innerHeight - r.bottom - 20 });
  }, [p.anchor]);

  // Focus once placed: a hidden element can't take focus.
  useEffect(() => {
    if (pos) el.current?.focus();
  }, [!pos]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!el.current?.contains(e.target as Node) && !p.anchor.contains(e.target as Node)) p.onClose(false);
    };
    const blur = () => p.onClose(false);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("blur", blur);
    };
  }, []);

  useEffect(() => {
    el.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (i: number, newWindow = false) => {
    p.onClose(false);
    const sp = p.spaces[i];
    if (!sp) p.onPicker();
    else if (sp.id !== p.current || newWindow) p.onShow(sp.id, newWindow ? { newWindow } : undefined);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const go = (i: number) => (e.preventDefault(), setActive((i + count) % count));
    if (e.key === "ArrowDown") go(active + 1);
    else if (e.key === "ArrowUp") go(active - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(count - 1);
    else if (e.key === "Enter" || e.key === " ") e.preventDefault(), pick(active, e.metaKey);
    else if (e.key === "Escape" || e.key === "Tab") e.preventDefault(), p.onClose(true);
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Type-ahead, like a native menu: jump to the first Space whose name starts with what was typed.
      const t = typed.current;
      t.text = (e.timeStamp - t.at < 700 ? t.text : "") + e.key.toLowerCase();
      t.at = e.timeStamp;
      const i = p.spaces.findIndex((sp) => sp.name.toLowerCase().startsWith(t.text));
      if (i >= 0) setActive(i);
    }
  };

  return (
    <div
      ref={el}
      className="space-menu"
      role="menu"
      aria-label="Spaces"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={pos ? { left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight } : { visibility: "hidden" }}
    >
      {p.spaces.map((sp, i) => {
        const on = sp.id === p.current;
        const attn = p.attention.get(sp.id);
        return (
          <div
            key={sp.id}
            data-i={i}
            role="menuitemradio"
            aria-checked={on}
            className={`space-item ${on ? "on" : ""} ${i === active ? "active" : ""} ${attn && !on ? `attn-${attn}` : ""}`}
            style={{ ["--hue" as string]: sp.hue }}
            onPointerMove={() => setActive(i)}
            onClick={(e) => pick(i, e.metaKey)}
            onContextMenu={(e) => (e.preventDefault(), p.onClose(false), p.onMenu(sp))}
          >
            <span className="space-dot" />
            <span className="space-item-text">
              <span className="space-item-name">{sp.name}</span>
              <span className="space-item-meta">
                {shortPath(sp.root)}
                {attn && !on ? (attn === "needs" ? " · needs you" : " · done") : ""}
              </span>
            </span>
            {i < 9 && <kbd>⌃{i + 1}</kbd>}
          </div>
        );
      })}
      <div className="space-menu-sep" role="separator" />
      <div
        data-i={count - 1}
        role="menuitem"
        className={`space-item space-item-open ${active === count - 1 ? "active" : ""}`}
        onPointerMove={() => setActive(count - 1)}
        onClick={() => pick(count - 1)}
      >
        <Symbol name="plus" size={ICON.row} />
        <span className="space-item-text">
          <span className="space-item-name">Open Space…</span>
        </span>
        <kbd>⌘O</kbd>
      </div>
    </div>
  );
}
