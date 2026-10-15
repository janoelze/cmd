// The person's last press in a package widget's window (docs/56, "Acts"): the one press model
// every verb that needs a press goes through (the acts, windows.open). An interaction counts
// only when its handler is on an element of the window's tree with that event (tree.ts
// `fires`); one that isn't is dropped, logged once per window. Typing into a field isn't a
// press. A verb takes the press it came after: one act, or one window, per press.
// A frame's page (FramePress) can't be watched like a tree: the app's gesture rule (renderer
// lib/frames.ts) says a call came right after a press in the frame, and the press is that
// call's alone, at most one a second per frame; it never arms the process, nor the other way.

import { logger } from "@cmd/protocol/node";
import type { Press } from "../api/act.ts";
import type { TreeState } from "./tree.ts";

const log = logger("widgets");

export class WindowPress implements Press {
  #at = 0;
  #remote = false;
  #warned = false;
  #label: string;

  /** `label`: the window, as the log names it. */
  constructor(label: string) {
    this.#label = label;
  }

  /** An interaction from the window: whether it is real (and so goes on to the widget's process). */
  interaction(tree: TreeState, handler: number, event: string, value: unknown, remote: boolean): boolean {
    if (!tree.fires(handler, event)) {
      if (!this.#warned) log.warn(`widget ${this.#label}: an interaction with no such handler (${handler} ${event.slice(0, 40)}) ignored`);
      this.#warned = true;
      return false;
    }
    if (event === "onChange" && typeof value === "string" && tree.typesInto(handler)) return true;
    this.#at = Date.now();
    this.#remote = remote;
    return true;
  }

  at(): number {
    return this.#at;
  }

  remote(): boolean {
    return this.#remote;
  }

  take(): void {
    this.#at = 0;
  }
}

/** The least time between two presses one frame's calls may carry (ms), as the app's gesture rule has it. */
export const FRAME_PRESS_EVERY_MS = 1000;

/** One frame's presses: each call the app marks `pressed` carries its own, if a second has passed since the last. */
export class FramePress {
  #last = -Infinity;

  /** The press a call carries: pressed (the app's gesture rule) and not within a second of the last one, else none. */
  forCall(pressed: boolean, now = Date.now()): Press {
    let at = 0;
    if (pressed && now - this.#last >= FRAME_PRESS_EVERY_MS) {
      at = now;
      this.#last = now;
    }
    return { at: () => at, remote: () => false, take: () => void (at = 0) };
  }
}
