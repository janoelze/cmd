// Magic (docs/56, "Magic on V3"): a Magic window's state while it makes a widget package (or
// ends with a command to run), the progress the core streams, the edit view's versions, and
// what the previewer is asked and answers.

import type { MagicPackageBuild, MagicPreviewTree } from "./magic-package.ts";
export type { MagicPackageMethods, MagicPackageInfo } from "./magic-package.ts";

/** One agent step as the window shows it. */
export interface MagicStep {
  id: number;
  tool: string;
  /** The agent's few words: "Looking at network services". */
  why: string;
  /** The command, path or URL, shortened. */
  detail: string;
  ms?: number;
  isError?: boolean;
  /** Output, shortened (for "How this was made"). */
  output?: string;
}

/** A Magic window's state (AppWindow.state of kind "magic"): a request, its build, or the command it ended with. */
export interface MagicState {
  [key: string]: unknown;
  /** The request, as typed; changes are appended to `history`. */
  prompt: string;
  phase: "empty" | "working" | "ready" | "error";
  /** "terminal": the build ended with a command to run (the window offers it). */
  kind?: "terminal";
  /** SF Symbol the build picked (shown instead of sparkles). */
  icon?: string;
  /** The command a "terminal" window offers. */
  command?: string;
  size?: "s" | "m" | "l" | "wide";
  /** A problem with the window itself (the build failed). */
  error?: string;
  steps?: MagicStep[];
  /** Earlier requests of this window (the first request, then changes). */
  history?: string[];
  /** The agent's closing words for the last build. */
  summary?: string;
  /** The build waits for the person: download Deno (magic.installRuntime) or not now (magic.skipRuntime). */
  askRuntime?: boolean;
  /** A build that makes (or changes) a widget package (docs/56, "Magic on V3"). */
  pkg?: MagicPackageBuild;
}

/** A version of a package made with Magic (magic.package): a build, a Restore or a hand edit. */
export interface MagicRevision {
  n: number;
  at: number;
  prompt: string;
  ok: boolean;
  problems?: string[];
  model?: string;
  /** Path of its screenshot, if any. */
  shot?: string;
  /** Files changed outside a build ("Edited by hand"): nothing checked them. */
  hand?: boolean;
}

/** One tree the core asks the previewer to draw at a size, measured (and a screenshot when asked). */
export interface MagicPreviewRequest {
  tree: MagicPreviewTree;
  width: number;
  height: number;
  shot?: boolean;
}

/** What a drawing reported: errors, characters of visible text, elements, whether a canvas/svg/img drew, its scroll size. */
export interface MagicPreviewShot {
  errors: string[];
  text: number;
  nodes: number;
  drawn: boolean;
  scrollW: number;
  scrollH: number;
  /** Base64 PNG, when asked for. */
  png?: string;
}

/** What widget packages run on (magic.runtime). */
export interface MagicRuntime {
  deno: string | null;
  version: string | null;
  /** sandbox-exec works here (else widgets run only with CMD_MAGIC_UNSANDBOXED=1). */
  sandbox: boolean;
  /** Who renders previews: "app", "playwright", or null. */
  previewer: string | null;
}

/** Progress of a run, streamed as `magic.stream` events (not persisted). */
export type MagicProgress =
  | { type: "step"; step: MagicStep }
  | { type: "title"; title: string }
  | { type: "verify" }
  | { type: "repair"; reason: string }
  | { type: "done" }
  | { type: "error"; message: string };
