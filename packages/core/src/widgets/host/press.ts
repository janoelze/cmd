// The person's last press in a package widget's window (docs/56, "Acts"): the one press model
// every verb that needs a press goes through (the acts, windows.open). An interaction counts
// only when its handler is on an element of the window's tree with that event (tree.ts
// `fires`); one that isn't is dropped, logged once per window. Typing into a field isn't a
// press. A verb takes the press it came after: one act, or one window, per press.

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
