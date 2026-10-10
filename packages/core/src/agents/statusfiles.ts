// The folder cmd's hook script writes to (hooks.ts), one per pane:
//
//   $TMPDIR/cmd-agents/<pane-id>/<HookEventName>.json   the newest event of each kind (for older cores)
//   $TMPDIR/cmd-agents/<pane-id>/log/<ts>.<pid>.<Event>.json   every event, the spool (activity/spool.ts)
//
// Every pane is started with CMD_PANE_ID=<pane-id>. The hook only writes files,
// so it is fast, works inside sandboxes, and works while the core is down. The
// core reads the spool alone: an agent's state comes from its events through
// one reducer (activity/reduce.ts), not from these files a second way.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { PaneId } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";

const log = logger("statusfiles");

export function statusRoot(): string {
  return path.join(os.tmpdir(), "cmd-agents");
}

export function removeStatus(paneId: PaneId, root = statusRoot()): void {
  fs.rmSync(path.join(root, paneId), { recursive: true, force: true });
}

/** Emits `changed(paneId)` when a pane's status files change. */
export class StatusWatcher extends EventEmitter<{ changed: [PaneId] }> {
  #watcher: fs.FSWatcher | null = null;
  #timers = new Map<string, NodeJS.Timeout>();
  #retry: NodeJS.Timeout | undefined;
  readonly root: string;

  constructor(root = statusRoot()) {
    super();
    this.root = root;
  }

  start(): void {
    fs.mkdirSync(this.root, { recursive: true });
    this.#watcher = fs.watch(this.root, { recursive: true }, (_e, name) => {
      const id = name?.toString().split(path.sep)[0];
      if (!id) return;
      clearTimeout(this.#timers.get(id));
      this.#timers.set(
        id,
        setTimeout(() => {
          this.#timers.delete(id);
          this.emit("changed", id);
        }, 30),
      );
    });
    this.#watcher.unref();
    // A watch can fail later (EMFILE); unhandled, that ends the core. Agents' events wait for the next try.
    this.#watcher.on("error", (err) => {
      log.warn(`watch of ${this.root} failed; trying again in 10 s`, err);
      this.#watcher?.close();
      this.#watcher = null;
      this.#retryLater();
    });
  }

  #retryLater(): void {
    this.#retry = setTimeout(() => {
      try {
        this.start();
        // What the hook wrote while nothing watched.
        for (const id of fs.readdirSync(this.root)) this.emit("changed", id);
      } catch (err) {
        log.warn(`watch of ${this.root} failed again`, err);
        this.#retryLater();
      }
    }, 10_000);
    this.#retry.unref();
  }

  close(): void {
    this.#watcher?.close();
    clearTimeout(this.#retry);
    for (const t of this.#timers.values()) clearTimeout(t);
  }
}

