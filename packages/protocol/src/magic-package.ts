// Magic making widget packages (docs/56-widgets-v3.md, "Magic on V3"): a build in a Magic
// window writes a package into the packages folder, asks for what it wants through the
// grants sheet as one of its steps, and the window becomes the package's widget. What the
// window, the Library and the previewer need to know of that.

import type { WindowId } from "./model.ts";
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

export interface MagicPackageMethods {
  /**
   * Change a package widget made with Magic: a Magic window opens beside it and builds the
   * change into the package (`prompt`), or asks what to change (none). `fix`: the request is
   * what is wrong with the window now (its stop reason and error).
   */
  "magic.editPackage": { params: { windowId: WindowId; prompt?: string; fix?: boolean }; result: { id: WindowId } };
}

/** A package widget's tree for the previewer to draw with the kit (magic.previewRequest's `tree`). */
export interface MagicPreviewTree {
  /** The wire messages the widget sent (its tree, then patches). */
  messages: (WidgetTree | WidgetPatch)[];
  title: string;
  icon: string;
  theme: "dark" | "light";
}
