// Where each window's content sits against its edges (window-design skill, Rules; docs/46),
// measured in the page: per window (.ui-window) on stage, how far its body, toolbar and footer
// content sits from the edges, to the nearest visible text (its glyph box, not the element),
// icon or drawing. Problems: a body whose left and right differ; a padded body or a list whose
// content isn't on its view's --inset (16px, a Page's 32) at the left and the top; a footer not
// at --bar-inset. Tables, trees, documents, media, splits and empty states have insets of their
// own and are only reported; toolbars are reported only (their items sit tighter). The one
// copy: the UI Workbench's audit overlay draws it, `pnpm workbench audit` prints it
// (globalThis.workbenchAudit).

export interface Box {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export interface AuditRow {
  window: string;
  part: "toolbar" | "body" | "footer";
  top: number;
  left: number;
  right: number;
  problems: string[];
  /** The part's box and its content's, in viewport pixels (for the overlay). */
  frame: Box;
  ink: Box;
}

const visible = (r: { width: number; height: number }) => r.width >= 1 && r.height >= 1;
const cut = (b: Box, c: Box): Box => ({ top: Math.max(b.top, c.top), left: Math.max(b.left, c.left), right: Math.min(b.right, c.right), bottom: Math.min(b.bottom, c.bottom) });
const size = (b: Box) => ({ width: b.right - b.left, height: b.bottom - b.top });
const box = (r: DOMRect): Box => ({ top: r.top, left: r.left, right: r.right, bottom: r.bottom });

/** The boxes of what shows inside el: text runs, icons, images, drawings; clipped by every box that scrolls or clips. */
function ink(el: Element): Box[] {
  const boxes: Box[] = [];
  const walk = (n: Node, clip: Box | null) => {
    if (n.nodeType === Node.TEXT_NODE) {
      if (!n.textContent?.trim()) return;
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const b of r.getClientRects()) {
        const c = clip ? cut(box(b), clip) : box(b);
        if (visible(size(c))) boxes.push(c);
      }
      return;
    }
    if (!(n instanceof Element)) return;
    const cs = getComputedStyle(n);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return;
    // Drawn things: SVG, images, fields, a frame's page (its box: its pixels are out of reach), icons (masks, as SF Symbols are drawn), and small filled or outlined shapes (a status dot's parts, a spinner).
    const empty = !n.children.length && !n.textContent?.trim();
    const filled = empty && (cs.maskImage !== "none" || cs.webkitMaskImage !== "none" || cs.backgroundImage !== "none" || ((cs.backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(cs.borderTopWidth) > 0) && n.getBoundingClientRect().width < 40));
    if (filled || n instanceof SVGSVGElement || n.tagName === "IMG" || n.tagName === "CANVAS" || n.tagName === "INPUT" || n.tagName === "IFRAME") {
      const b = clip ? cut(box(n.getBoundingClientRect()), clip) : box(n.getBoundingClientRect());
      if (visible(size(b))) boxes.push(b);
      return;
    }
    const clips = n !== el && (cs.overflowX !== "visible" || cs.overflowY !== "visible");
    const inner = clips ? (clip ? cut(box(n.getBoundingClientRect()), clip) : box(n.getBoundingClientRect())) : clip;
    for (const c of n.childNodes) walk(c, inner);
  };
  walk(el, null);
  return boxes;
}

/** An item with a visible fill or edge (a field, a pressed button) shows its box; a borderless one, its icon or label. */
const shows = (c: Element) => {
  const cs = getComputedStyle(c);
  return cs.backgroundColor !== "rgba(0, 0, 0, 0)" || cs.boxShadow !== "none" || parseFloat(cs.borderLeftWidth) > 0;
};
const items = (bar: Element): Box[] =>
  [...bar.querySelectorAll(":scope > :not(.ui-tb-spacer):not(.ui-tb-group), :scope > .ui-tb-group > *")]
    .flatMap((c) => (shows(c) || [...c.querySelectorAll("*")].some((d) => d.matches("input") && shows(c.firstElementChild ?? c)) ? [box(c.getBoundingClientRect())] : ink(c)))
    .filter((b) => visible(size(b)));

export function audit(root: ParentNode = document): { inset: number; barInset: number; rows: AuditRow[] } {
  const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--inset")) || 16;
  const barInset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bar-inset")) || 12;
  const rows: AuditRow[] = [];
  for (const win of root.querySelectorAll(".ui-window")) {
    const name = win.querySelector(".ui-window-bar-name")?.textContent?.trim() || "window";
    const w = Math.round(win.getBoundingClientRect().width);
    for (const view of win.querySelectorAll(".ui-view")) {
      const parts = [
        ["toolbar", view.querySelector(":scope > .ui-tb")],
        ["body", view.querySelector(":scope > .ui-view-body")],
        ["footer", view.querySelector(":scope > .ui-view-footer")],
      ] as const;
      for (const [part, el] of parts) {
        if (!el) continue;
        // Bars are measured to their items' boxes (a field's edge, not its placeholder); bodies to their ink. What shows only: clipped to the part.
        const frame = box(el.getBoundingClientRect());
        const found = (part === "toolbar" ? items(el) : ink(el)).map((b) => cut(b, frame)).filter((b) => visible(size(b)));
        if (!found.length) continue;
        const extent: Box = { top: Math.min(...found.map((b) => b.top)), left: Math.min(...found.map((b) => b.left)), right: Math.max(...found.map((b) => b.right)), bottom: Math.max(...found.map((b) => b.bottom)) };
        const m = { top: Math.round(extent.top - frame.top), left: Math.round(extent.left - frame.left), right: Math.round(frame.right - extent.right) };
        const problems: string[] = [];
        if (part === "body" && Math.abs(m.left - m.right) > 1 && el.querySelector(".ui-grid, .ui-list, .ui-measure, .ui-doc, .ui-page, .ui-media, .ui-split, .ui-empty") === null) problems.push(`left ${m.left} ≠ right ${m.right}`);
        // On the inset: a padded body or a list, unless it holds something with its own (a table, tree, document, media, split, state).
        const own = el.querySelector(".ui-grid, .ui-tree, .ui-measure, .ui-doc, .ui-media, .ui-split, .ui-viewstate, .ui-diff, .ui-tiles") !== null;
        const viewInset = parseFloat(getComputedStyle(el).getPropertyValue("--inset")) || inset; // the body's own (a Page's)
        if (part === "body" && !own && (el.hasAttribute("data-inset") || el.querySelector(":scope > .ui-list"))) {
          // An icon's box sits a pixel or two outside its glyph; text trims to the cap.
          if (Math.abs(m.left - viewInset) > 2) problems.push(`left ${m.left}, not --inset (${viewInset})`);
          if (Math.abs(m.top - viewInset) > 3) problems.push(`top ${m.top}, not --inset (${viewInset})`);
        }
        // Toolbars are reported, not checked: their items sit tighter than the content (6–8px), an open decision (window-design skill).
        if (part === "footer" && Math.abs(m.left - barInset) > 1) problems.push(`left ${m.left}, not --bar-inset (${barInset})`);
        if (part === "footer" && el.querySelector(".ui-status-line-end") && Math.abs(m.right - barInset) > 1) problems.push(`right ${m.right}, not --bar-inset (${barInset})`);
        rows.push({ window: `${name} (${w}px)`, part, ...m, problems, frame, ink: extent });
      }
    }
  }
  return { inset, barInset, rows };
}
