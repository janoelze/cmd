// A package widget window's Pictures as the renderer gets them (API 1.3, docs/57 A5): the tree
// and patches go to the window with each Picture's src replaced, never as the process sent
// them. A data: src is checked (api/picture.ts: its type, its bytes, 512 KB); an https src is
// fetched by the core within the window's grant and net limit (the window's API: picture())
// and stands as null (the placeholder) until it comes, when the whole tree goes again; one
// that is refused or fails stays null, its reason one line in the widget's log. A tree holds
// at most PICTURE_TREE_MAX of pictures: one past it shows its placeholder. So the renderer and
// a paired device never get a remote URL. The core's own tree (tree.ts) keeps the src as sent,
// for a resync to resolve again.

import { PICTURE_TREE_MAX, type TreeElement, type TreeNode, type WidgetPatch, type WidgetTree, type WireValue } from "@cmd/protocol";
import { ApiRefusal } from "../api/access.ts";
import { checkDataSrc } from "../api/picture.ts";
import type { TreeState } from "./tree.ts";

/** How long a refused or failed https src stands as null before it is asked again (the net limit's minute). */
const RETRY_MS = 60_000;
/** Pictures fetched in a burst redraw the tree once, this long after the first. */
const REDRAW_MS = 50;

export interface PicturesOptions {
  /** An https src as a data: URL (the window's API: the grant, the net limit, the cache), or a refusal. */
  fetch(src: string): Promise<string>;
  /** Fetched pictures came: send the whole tree again. */
  changed(): void;
  /** A line for the widget's log. */
  warn(message: string): void;
  now?: () => number;
}

export class TreePictures {
  readonly #o: PicturesOptions;
  /** What each https src came to for this window: its data: URL, or null (refused, failed) since `at`. */
  readonly #got = new Map<string, { src: string | null; at: number }>();
  readonly #asking = new Set<string>();
  /** The characters each Picture shows now, by node. */
  readonly #shown = new Map<number, number>();
  readonly #warned = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #ended = false;

  constructor(o: PicturesOptions) {
    this.#o = o;
  }

  /** A whole tree, its Pictures as the renderer may get them. */
  tree(t: WidgetTree): WidgetTree {
    this.#shown.clear();
    return { ...t, nodes: t.nodes.map((n) => this.#node(n)) };
  }

  /** A patch, applied to `tree` already, its Pictures' srcs as the renderer may get them. */
  patch(p: WidgetPatch, tree: TreeState): WidgetPatch {
    // What the patch removed makes room first.
    for (const id of this.#shown.keys()) if (!tree.typeOf(id)) this.#shown.delete(id);
    const ops = p.ops.map((op) => {
      if (op.op === "insert") return { ...op, node: this.#node(op.node) };
      if (op.op !== "props") return op;
      // A node removed later in the same patch has no type left: treated as a Picture (it is gone anyway).
      const type = tree.typeOf(op.id);
      if (type !== "Picture" && type !== undefined) return op;
      if (op.unset.includes("src")) this.#shown.delete(op.id);
      return "src" in op.set ? { ...op, set: { ...op.set, src: this.#src(op.id, op.set.src!) } } : op;
    });
    for (const id of this.#shown.keys()) if (!tree.typeOf(id)) this.#shown.delete(id);
    return { ...p, ops };
  }

  /** The window's process stopped or started again: nothing more is sent from what it asked. */
  end(): void {
    this.#ended = true;
    if (this.#timer) clearTimeout(this.#timer);
  }

  #node(n: TreeNode): TreeNode {
    if (n.type === "#text") return n;
    const el = n as TreeElement;
    const props = el.type === "Picture" && el.props && "src" in el.props ? { ...el.props, src: this.#src(el.id, el.props.src!) } : el.props;
    return { ...el, props, children: (el.children ?? []).map((c) => this.#node(c)) };
  }

  /** One Picture's src: a checked data: URL, or null (none, waiting, refused, past the tree's limit). */
  #src(id: number, v: WireValue): string | null {
    let out: string | null = null;
    if (typeof v === "string" && v.startsWith("data:")) {
      try {
        out = checkDataSrc(v);
      } catch (e) {
        this.#say(v.slice(0, 64), (e as Error).message);
      }
    } else if (typeof v === "string") out = this.#remote(v);
    const was = this.#shown.get(id) ?? 0;
    let total = 0;
    for (const n of this.#shown.values()) total += n;
    if (out && total - was + out.length > PICTURE_TREE_MAX) {
      this.#say("tree", `Picture: this window's pictures are over ${PICTURE_TREE_MAX / 1024 / 1024} MB together, so one shows its placeholder. Use smaller pictures.`);
      out = null;
    }
    this.#shown.set(id, out?.length ?? 0);
    return out;
  }

  /** An https src: what it came to, or null while it is fetched (the tree goes again when it comes). */
  #remote(src: string): string | null {
    const now = (this.#o.now ?? Date.now)();
    const got = this.#got.get(src);
    if (got && (got.src !== null || now - got.at < RETRY_MS)) return got.src;
    if (this.#asking.has(src) || this.#ended) return null;
    this.#asking.add(src);
    this.#o.fetch(src).then(
      (data) => this.#came(src, data),
      (e: unknown) => {
        this.#say(src, e instanceof ApiRefusal ? e.error.message : `Picture: ${(e as Error).message}`);
        this.#came(src, null);
      },
    );
    return null;
  }

  #came(src: string, data: string | null): void {
    this.#asking.delete(src);
    this.#got.set(src, { src: data, at: (this.#o.now ?? Date.now)() });
    // A failure shows as the placeholder it already is: only a picture needs the tree again.
    if (data === null || this.#ended || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#ended) this.#o.changed();
    }, REDRAW_MS);
    this.#timer.unref?.();
  }

  /** One line in the widget's log per src (or limit), not one per redraw. */
  #say(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    if (this.#warned.size > 500) this.#warned.clear();
    this.#warned.add(key);
    this.#o.warn(message);
  }
}
