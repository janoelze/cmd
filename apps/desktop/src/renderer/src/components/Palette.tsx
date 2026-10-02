import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteItem {
  id: string;
  group: "Commands" | "Sessions" | "Tools";
  label: string;
  hint?: string;
  run: () => void;
}

const PREFIX: Record<string, PaletteItem["group"]> = { ">": "Commands", "@": "Sessions", "#": "Tools" };

/** Subsequence match; earlier and tighter matches score higher. */
function score(label: string, q: string): number {
  if (!q) return 1;
  const s = label.toLowerCase();
  const direct = s.indexOf(q);
  if (direct >= 0) return 100 - direct;
  let i = 0;
  let gaps = 0;
  for (const ch of q) {
    const j = s.indexOf(ch, i);
    if (j < 0) return 0;
    gaps += j - i;
    i = j + 1;
  }
  return Math.max(1, 50 - gaps);
}

export function Palette({
  items,
  recent = [],
  onRun,
  onClose,
}: {
  items: PaletteItem[];
  /** Recently run item ids, most recent first; ranked first. */
  recent?: string[];
  onRun?: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  const results = useMemo(() => {
    const group = PREFIX[query[0] ?? ""];
    const q = (group ? query.slice(1) : query).trim().toLowerCase();
    return items
      .filter((it) => !group || it.group === group)
      .map((it) => {
        const s = score(it.label, q);
        const r = recent.indexOf(it.id);
        // Recent items first when the query is empty; a small boost otherwise.
        return { it, s: s > 0 && r >= 0 ? s + (q ? 10 : 1000) - r : s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.it);
  }, [items, query, recent]);

  useEffect(() => setActive(0), [query]);

  const run = (it: PaletteItem | undefined) => {
    if (!it) return;
    onClose();
    onRun?.(it.id);
    it.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="palette-input"
          placeholder="Type a command, @session, #tool…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(a + 1, results.length - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(a - 1, 0)));
            else if (e.key === "Enter") run(results[active]);
          }}
        />
        <ul className="palette-list">
          {results.map((it, i) => (
            <li
              key={it.id}
              className={i === active ? "on" : ""}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(it)}
            >
              <span className="palette-group">{it.group}</span>
              <span className="palette-label">{it.label}</span>
              {it.hint && <kbd>{it.hint}</kbd>}
            </li>
          ))}
          {results.length === 0 && <li className="palette-empty">Nothing matches. Transcript search (?) is next.</li>}
        </ul>
        <footer className="palette-foot">
          <span><kbd>↑↓</kbd> move</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>&gt;</kbd> commands <kbd>@</kbd> sessions <kbd>#</kbd> tools</span>
        </footer>
      </div>
    </div>
  );
}
