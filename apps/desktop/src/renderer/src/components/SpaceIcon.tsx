// A Space's icon (an SF Symbol tinted with the Space's hue, marked when something
// in it needs you or finished unseen) and the picker that sets it: a filterable
// grid of symbols, or any SF Symbol name typed in full.

import { useEffect, useMemo, useRef, useState } from "react";
import { ICON_NAME, spaceIcon, type Space } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { ICON, Symbol } from "./Symbol.tsx";

export function SpaceIcon(p: { space: Space; attention?: "needs" | "unseen"; size?: number }) {
  return (
    <span className={`space-icon ${p.attention ? `attn-${p.attention}` : ""}`} style={{ ["--hue" as string]: p.space.hue }}>
      <Symbol name={spaceIcon(p.space)} size={p.size ?? ICON.row} />
    </span>
  );
}

/** The grid: SF Symbol names, with extra words to find them by after a space. */
const SYMBOLS = [
  "house home", "folder", "terminal shell console", "chevron.left.forwardslash.chevron.right code html", "curlybraces code json",
  "hammer build", "wrench.and.screwdriver tools", "gearshape settings config", "cpu chip", "memorychip",
  "server.rack backend", "externaldrive disk", "cloud", "globe web site", "network",
  "antenna.radiowaves.left.and.right", "arrow.triangle.branch git", "point.3.connected.trianglepath.dotted graph", "cube 3d", "shippingbox package",
  "archivebox", "tray inbox", "doc.text document", "book docs", "books.vertical library",
  "newspaper blog", "bookmark", "tag", "flag", "flag.checkered",
  "bell", "envelope mail", "bubble.left.and.bubble.right chat", "paperplane send", "phone",
  "person user", "person.2 team", "briefcase work", "building.2 company office", "storefront shop",
  "cart shop", "creditcard payment", "dollarsign.circle money", "chart.bar stats", "chart.line.uptrend.xyaxis growth",
  "chart.pie", "tablecells spreadsheet", "checklist todo", "list.bullet", "calendar",
  "clock time", "map", "mappin", "location", "airplane travel",
  "car", "bicycle", "tram", "sailboat", "mountain.2",
  "tent camping", "leaf", "tree", "flame fire", "drop water",
  "bolt lightning", "snowflake", "sun.max", "moon night", "star",
  "heart", "sparkles ai", "wand.and.stars magic", "lightbulb idea", "brain ai",
  "atom science", "flask lab", "testtube.2 test", "function math", "number",
  "graduationcap school", "pencil", "paintbrush design", "paintpalette color", "scissors",
  "photo image", "camera", "video", "film movie", "tv",
  "display monitor", "laptopcomputer mac", "iphone mobile", "applewatch", "keyboard",
  "gamecontroller game", "puzzlepiece plugin", "music.note", "headphones audio", "waveform sound",
  "mic", "pianokeys", "guitars", "theatermasks", "trophy",
  "crown", "gift", "lock security", "key", "shield",
  "eye", "magnifyingglass search", "ladybug bug", "ant", "tortoise slow",
  "hare fast", "pawprint", "fish", "bird", "cup.and.saucer coffee",
  "fork.knife food", "dumbbell fitness", "figure.run", "cross.case health", "app",
  "square.grid.2x2 apps", "circle.hexagongrid", "square.stack.3d.up layers", "rectangle.3.group", "sparkle",
].map((s) => {
  const [name, ...words] = s.split(" ");
  return { name: name!, words: `${name!.replace(/\./g, " ")} ${words.join(" ")}` };
});

const COLS = 10;

export function SpaceIconPicker(p: { space: Space; onClose: () => void }) {
  const current = spaceIcon(p.space);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = q ? SYMBOLS.filter((s) => q.split(/\s+/).every((w) => s.words.includes(w))).map((s) => s.name) : SYMBOLS.map((s) => s.name);
    // Any SF Symbol, typed in full.
    if (q && ICON_NAME.test(q) && !hits.includes(q)) hits.unshift(q);
    return hits;
  }, [query]);
  const [active, setActive] = useState(() => Math.max(0, shown.indexOf(current)));
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => setActive((a) => (query ? 0 : a)), [query]);
  useEffect(() => {
    grid.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const set = (icon: string | null) => {
    p.onClose();
    void cmd.call("space.update", { id: p.space.id, icon }).catch(() => {});
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const move = (d: number) => (e.preventDefault(), setActive((a) => Math.max(0, Math.min(shown.length - 1, a + d))));
    if (e.key === "Escape") p.onClose();
    else if (e.key === "ArrowRight") move(1);
    else if (e.key === "ArrowLeft") move(-1);
    else if (e.key === "ArrowDown") move(COLS);
    else if (e.key === "ArrowUp") move(-COLS);
    else if (e.key === "Enter" && shown[active]) set(shown[active]!);
  };

  return (
    <div className="palette-backdrop" onMouseDown={p.onClose}>
      <div className="palette icon-picker" onMouseDown={(e) => e.stopPropagation()} style={{ ["--hue" as string]: p.space.hue }}>
        <input
          autoFocus
          className="palette-input"
          placeholder={`Icon for ${p.space.name}: search, or type an SF Symbol name`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="icon-grid" ref={grid} role="listbox" aria-label="Icons">
          {shown.map((name, i) => (
            <button
              key={name}
              data-i={i}
              role="option"
              aria-selected={name === current}
              aria-label={name}
              className={`icon-cell ${i === active ? "active" : ""} ${name === current ? "current" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => set(name)}
            >
              <Symbol name={name} size={16} />
            </button>
          ))}
          {!shown.length && <div className="palette-empty">No icon matches. Type a full SF Symbol name, like “leaf.fill”.</div>}
        </div>
        <footer className="palette-foot">
          <span className="icon-picker-name">{shown[active] ?? ""}</span>
          <span>
            <kbd>↵</kbd> set
          </span>
          {p.space.icon !== null && (
            <button className="icon-picker-reset" onClick={() => set(null)}>
              Use the default
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
