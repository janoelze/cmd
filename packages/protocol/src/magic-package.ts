// Magic making widget packages (docs/56-widgets-v3.md, "Magic on V3"): a build in a Magic
// window writes a package into the packages folder, asks for what it wants through the
// grants sheet as one of its steps, and the window becomes the package's widget. What the
// window, the Library and the previewer need to know of that.

import type { WindowId } from "./model.ts";
import type { MagicRevision } from "./magic.ts";
import type { WidgetPatch, WidgetTree } from "./widget-tree.ts";

/**
 * A package made with Magic says so in its package.json (`cmd.magic`), written by cmd after
 * each build (the agent's own writes can't change it): what was first asked, when it was
 * made, and how many builds it has had. The Library lists such a package under Your Widgets.
 */
export interface MagicMark {
  request: string;
  /** ISO date of the first build. */
  madeAt: string;
  /** Builds kept (revisions in the instance's widget-packages/<name>/revisions). */
  revisions: number;
}

/** A Magic window building a package (MagicState.pkg). */
export interface MagicPackageBuild {
  /** The package's name (its folder in the packages folder). */
  name: string;
  /** The package window this build changes (Edit with Magic, Fix with Magic); none for a new widget. */
  editing?: WindowId;
  /** The build waits for the person to grant what the package asks (the grants sheet; Allow… asks again). */
  asking?: boolean;
}

/** A package made with Magic as the edit view (⌘E) shows it (magic.package). */
export interface MagicPackageInfo {
  name: string;
  /** Its folder in the packages folder. */
  dir: string;
  /** A linked package: the person's own folder it links to (Restore doesn't write there). */
  link?: string;
  /** Its own files, relative. */
  files: string[];
  /** Every version, oldest first; the last is what its files are, unless `edited`. */
  revisions: MagicRevision[];
  /** Its files differ from the last version (edited by hand since; a version once it reloads). */
  edited: boolean;
  /** A build is changing it now. */
  building: boolean;
}

export interface MagicPackageMethods {
  /**
   * Change a package widget made with Magic: a Magic window opens beside it and builds the
   * change into the package (`prompt`), or asks what to change (none). `fix`: the request is
   * what is wrong with the window now (its stop reason and error).
   */
  "magic.editPackage": { params: { windowId: WindowId; prompt?: string; fix?: boolean }; result: { id: WindowId } };
  /** The package a window shows, when Magic made it: its folder, files and versions (the edit view); null for any other. */
  "magic.package": { params: { windowId: WindowId }; result: MagicPackageInfo | null };
  /** Bring back a version of that package, as a new version; the package's windows reload. Refused for a linked package. */
  "magic.restorePackage": { params: { windowId: WindowId; revision: number }; result: null };
}

/** A package widget's tree for the previewer to draw with the kit (magic.previewRequest's `tree`). */
export interface MagicPreviewTree {
  /** The wire messages the widget sent (its tree, then patches). */
  messages: (WidgetTree | WidgetPatch)[];
  title: string;
  icon: string;
  /** A theme's id ("dark", "light", "gruvbox-dark"). */
  theme: string;
}

/** The reference window sizes (the reference windows' matrix, docs/40): what previews and the Workbench draw widgets at. */
export const PREVIEW_SIZES = { narrow: [320, 520], regular: [560, 460], wide: [900, 560] } as const;
export type PreviewSize = keyof typeof PREVIEW_SIZES;

/**
 * Evaluated in the preview page (renderer/preview.html): once it has loaded its drawing (a module
 * after load), draws the tree, waits for it to settle and measures it (a MagicPreviewShot without
 * the PNG). The app's previewer and Playwright's run this same script.
 */
export const previewScript = (tree: MagicPreviewTree): string =>
  `(async () => { for (let i = 0; i < 200 && !window.__cmdPreview; i++) await new Promise((r) => setTimeout(r, 25)); return window.__cmdPreview(${JSON.stringify(tree)}); })()`;
