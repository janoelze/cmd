// The last full tree of a package widget's window (docs/56, "The wire"), kept by the core so
// a window drawn later gets the whole tree, not a stream of patches. Patches apply as the
// protocol's WireTree applies them (widget-patch.ts), in place, on a copy of what the process
// sent (the message itself goes on to the renderer as it came); a patch that doesn't fit
// loses the tree, and the process is asked for the whole tree again.

import { API_ELEMENTS, WireTree, type ApiElementSpec, type TreeElement, type WidgetPatch, type WidgetTree, type WireValue } from "@cmd/protocol";

export class TreeState {
  readonly #tree = new WireTree({ adopt: (n) => structuredClone(n) });

  get rev(): number {
    return this.#tree.rev;
  }

  /** Whether there is a tree yet. */
  get ready(): boolean {
    return this.#tree.ready;
  }

  /** The whole tree as a message. */
  tree(): WidgetTree {
    return this.#tree.tree();
  }

  /** Whether `handler` fires as `event` on an element whose spec marks it typing (a field's onChange, a Frame's onMessage): not a press. */
  typing(handler: number, event: string): boolean {
    for (const node of this.#tree.nodes()) {
      const spec = node.type === "#text" ? undefined : (API_ELEMENTS as Record<string, ApiElementSpec>)[node.type];
      const h = spec?.events[event]?.typing ? (node as TreeElement).props[event] : undefined;
      if (h && typeof h === "object" && !Array.isArray(h) && (h as { $handler?: unknown }).$handler === handler) return true;
    }
    return false;
  }

  /** Each Frame's `src` in the tree (its pages, frame.ts). */
  pages(): string[] {
    const out = new Set<string>();
    for (const node of this.#tree.nodes()) if (node.type === "Frame" && typeof (node as TreeElement).props.src === "string") out.add((node as TreeElement).props.src as string);
    return [...out];
  }

  /** Whether the tree has an element of `type` (a Frame: its window serves frames, frame.ts). */
  has(type: string): boolean {
    for (const node of this.#tree.nodes()) if (node.type === type) return true;
    return false;
  }

  reset(): void {
    this.#tree.reset();
  }

  setTree(t: WidgetTree): void {
    this.#tree.load(t);
  }

  /** Apply a patch; false when it doesn't fit (then, unless it was one already applied, the tree is gone until the next whole one). */
  apply(p: WidgetPatch): boolean {
    try {
      this.#tree.apply(p);
      return true;
    } catch {
      // A PatchError, or a malformed node: either way the process sends the whole tree again.
      return false;
    }
  }

  /**
   * Whether `handler` fires as `event` on an element of the tree: one of the events its spec
   * names, or "run" inside a prop that holds handlers (a menu entry, an action, a view state's).
   */
  fires(handler: number, event: string): boolean {
    for (const node of this.#tree.nodes()) {
      const spec = node.type === "#text" ? undefined : (API_ELEMENTS as Record<string, ApiElementSpec>)[node.type];
      if (!spec) continue;
      for (const [k, v] of Object.entries((node as TreeElement).props)) {
        if (k in spec.events ? k === event && holds(v, handler, false) : event === "run" && HOLDERS.has(spec.props[k]?.type as string) && holds(v, handler, true)) return true;
      }
    }
    return false;
  }
}

/** The prop types a "run" handler sits inside. */
const HOLDERS = new Set(["menu", "action", "viewState"]);

/** Whether `v` is the handler ref (or, `deep`, holds it anywhere inside). */
function holds(v: WireValue | undefined, handler: number, deep: boolean): boolean {
  if (!v || typeof v !== "object") return false;
  if (!Array.isArray(v) && (v as { $handler?: unknown }).$handler === handler) return true;
  return deep && Object.values(v).some((x) => holds(x as WireValue, handler, true));
}
