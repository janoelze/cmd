// A workspace's icon (a Phosphor icon, marked with a dot when something
// in it needs you or finished unseen) and the picker that sets it: a filterable
// grid of icons, searched further among every Phosphor icon by name.

import { Dialog, EmptyState, Icon, ICON, ICONS, iconOr, LinkButton, type IconName } from "@cmd/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { workspaceIcon, type Workspace } from "@cmd/protocol";
import { cmd } from "../lib/bridge.ts";

export function WorkspaceIcon(p: { workspace: Workspace; attention?: "needs" | "unseen"; size?: number }) {
  return (
    <span className={`workspace-icon ${p.attention ? `attn-${p.attention}` : ""}`}>
      <Icon name={iconOr(workspaceIcon(p.workspace), "folder")} size={p.size ?? ICON.row} />
    </span>
  );
}

/** The grid: Phosphor icons, with extra words to find them by after a space. */
const GRID = [
  "house home", "folder", "terminal-window shell console", "code html", "brackets-curly json",
  "hammer build", "wrench tools", "gear settings config", "cpu chip", "memory",
  "hard-drives server backend", "hard-drive disk", "cloud", "globe web site", "network",
  "broadcast", "git-branch", "graph", "cube 3d", "package",
  "archive", "tray inbox", "file-text document", "book docs", "books library",
  "newspaper blog", "bookmark-simple", "tag", "flag", "flag-checkered",
  "bell", "envelope mail", "chats chat", "paper-plane-tilt send", "phone",
  "user person", "users team", "briefcase work", "buildings company office", "storefront shop",
  "shopping-cart shop", "credit-card payment", "currency-circle-dollar money", "chart-bar stats", "chart-line-up growth",
  "chart-pie", "table spreadsheet", "list-checks todo", "list-bullets", "calendar",
  "clock time", "map-trifold", "map-pin", "navigation-arrow location", "airplane travel",
  "car", "bicycle", "tram", "sailboat", "mountains",
  "tent camping", "leaf", "tree", "flame fire", "drop water",
  "lightning", "snowflake", "sun", "moon night", "star",
  "heart", "sparkle ai", "magic-wand", "lightbulb idea", "brain ai",
  "atom science", "flask lab", "test-tube", "function math", "hash number",
  "graduation-cap school", "pencil-simple", "paint-brush design", "palette color", "scissors",
  "image photo", "camera", "video-camera", "film-strip movie", "television tv",
  "monitor display", "laptop mac", "device-mobile phone", "watch", "keyboard",
  "game-controller game", "puzzle-piece plugin", "music-note", "headphones audio", "waveform sound",
  "microphone", "piano-keys", "guitar", "mask-happy theatre", "trophy",
  "crown", "gift", "lock security", "key", "shield",
  "eye", "magnifying-glass search", "bug", "bug-beetle", "rabbit fast",
  "paw-print", "cat", "dog", "fish", "bird",
  "coffee", "fork-knife food", "barbell fitness", "person-simple-run", "first-aid-kit health",
  "app-window", "squares-four apps", "hexagon", "stack layers", "layout",
].map((s) => {
  const [name, ...words] = s.split(" ");
  return { name: name as IconName, words: `${name!.replace(/-/g, " ")} ${words.join(" ")}` };
});
const ALL = Object.keys(ICONS) as IconName[];

const COLS = 10;

export function WorkspaceIconPicker(p: { open?: boolean; workspace: Workspace; onClose: () => void }) {
  const current = workspaceIcon(p.workspace);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GRID.map((s) => s.name);
    const words = q.split(/[\s-]+/);
    const hits = GRID.filter((s) => words.every((w) => s.words.includes(w))).map((s) => s.name);
    // Then every other Phosphor icon whose name has the words.
    for (const name of ALL) if (!hits.includes(name) && words.every((w) => name.includes(w))) hits.push(name);
    return hits;
  }, [query]);
  const [active, setActive] = useState(() => Math.max(0, shown.indexOf(current as IconName)));
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => setActive((a) => (query ? 0 : a)), [query]);
  useEffect(() => {
    grid.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const set = (icon: IconName | null) => {
    p.onClose();
    void cmd.call("workspace.update", { id: p.workspace.id, icon }).catch(() => {});
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const move = (d: number) => (e.preventDefault(), setActive((a) => Math.max(0, Math.min(shown.length - 1, a + d))));
    if (e.key === "ArrowRight") move(1);
    else if (e.key === "ArrowLeft") move(-1);
    else if (e.key === "ArrowDown") move(COLS);
    else if (e.key === "ArrowUp") move(-COLS);
    // Handled here: closing hands focus back to the button that opened it (at once with
    // Reduce Motion), and an Enter left to run on would click it.
    else if (e.key === "Enter" && shown[active]) e.preventDefault(), set(shown[active]!);
  };

  return (
    <Dialog open={p.open ?? true} onClose={p.onClose} padded={false} scrim={false} width={460} className="icon-picker" label="Workspace icon">
      <input
        autoFocus
        className="palette-input"
        placeholder={`Icon for ${p.workspace.name}: search`}
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
            <Icon name={name} size={16} />
          </button>
        ))}
        {!shown.length && <EmptyState compact>No icon matches. Try another word, like “leaf”.</EmptyState>}
      </div>
      <footer className="palette-foot">
        <span className="icon-picker-name">{shown[active] ?? ""}</span>
        <span>
          <kbd>↵</kbd> set
        </span>
        {p.workspace.icon !== null && (
          <LinkButton onClick={() => set(null)}>Use the default</LinkButton>
        )}
      </footer>
    </Dialog>
  );
}
