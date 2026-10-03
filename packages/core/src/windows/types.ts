// Window type registry. Every kind of window (terminal, browser, files, text,
// and later plugin-provided ones) is a WindowType: what it is, what it can open,
// and how its state is created and updated. The core stores each window's state
// as opaque JSON, so new types need no protocol or storage changes.
//
// The UI half of a type (its view, title-bar meta, menus) is registered
// separately in the renderer (apps/desktop/src/renderer/src/windows/).

import type { WindowTypeInfo } from "@cmd/protocol";

/** Something to open: a folder/file path or a URL. */
export type OpenTarget = { type: "path"; path: string; isDir: boolean; ext: string; looksText: () => boolean } | { type: "url"; url: string; scheme: string };

export interface OpenRule {
  /** Opens folders. */
  folders?: boolean;
  /** Opens files with these extensions (lowercase, no dot; "makefile" matches the bare name). */
  extensions?: string[];
  /** Opens files that look like text (no NUL bytes, size ≤ TEXT_MAX_BYTES). Least specific. */
  text?: boolean;
  /** Opens URLs with these schemes ("http", "https"). */
  schemes?: string[];
  /** Tie-breaker between types matching equally specifically (higher wins). */
  priority?: number;
}

export interface WindowType<S extends Record<string, unknown> = Record<string, unknown>> {
  kind: string;
  /** "Browser", "Files", … */
  title: string;
  /** SF Symbol name. */
  icon: string;
  /** What `open <target>` (shell, file tree, palette) can route to this type. */
  opens?: OpenRule;
  /** Turn a matched open target into create input. */
  fromTarget?(target: OpenTarget): Record<string, unknown>;
  /** Initial state and title from create input (throws on invalid input). */
  create(input: Record<string, unknown>): { state: S; title: string };
  /** Apply a state patch from the UI (navigation, …); return the new state and maybe a title. */
  update?(state: S, patch: Record<string, unknown>): { state: S; title?: string };
}

export class WindowTypes {
  #types = new Map<string, WindowType>();

  register<S extends Record<string, unknown>>(type: WindowType<S>): void {
    if (this.#types.has(type.kind)) throw new Error(`window type already registered: ${type.kind}`);
    this.#types.set(type.kind, type as unknown as WindowType);
  }

  get(kind: string): WindowType | undefined {
    return this.#types.get(kind);
  }

  all(): WindowType[] {
    return [...this.#types.values()];
  }

  /** Serializable description for the UI, CLI and shell integration. */
  info(): WindowTypeInfo[] {
    return this.all().map((t) => ({ kind: t.kind, title: t.title, icon: t.icon, opens: t.opens ?? {} }));
  }

  /**
   * The type that should open a target: an explicit override first ("ext:kind"),
   * then the most specific rule (scheme / extension > folder > looks-like-text),
   * then priority. null = none of ours (use the default app).
   */
  resolve(target: OpenTarget, overrides: Record<string, string> = {}): WindowType | null {
    if (target.type === "path" && !target.isDir && overrides[target.ext]) {
      const t = this.get(overrides[target.ext]!);
      if (t) return t;
    }
    let best: { t: WindowType; score: number } | null = null;
    for (const t of this.all()) {
      const r = t.opens;
      if (!r) continue;
      let specificity = 0;
      if (target.type === "url") {
        if (r.schemes?.includes(target.scheme)) specificity = 3;
      } else if (target.isDir) {
        if (r.folders) specificity = 2;
      } else if (r.extensions?.includes(target.ext)) {
        specificity = 3;
      } else if (r.text && target.looksText()) {
        specificity = 1;
      }
      if (!specificity) continue;
      const score = specificity * 1000 + (r.priority ?? 0);
      if (!best || score > best.score) best = { t, score };
    }
    return best?.t ?? null;
  }
}

/** Parses the open.handlers setting: "md: browser, log: text" → { md: "browser", log: "text" }. */
export function parseOverrides(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(",")) {
    const [ext, kind] = part.split(":").map((x) => x?.trim().toLowerCase().replace(/^\./, ""));
    if (ext && kind) out[ext] = kind;
  }
  return out;
}
