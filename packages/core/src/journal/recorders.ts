// What the journal records as it happens, because nothing else keeps it:
// commands terminals ran (CommandLog is in memory and capped), pages browser
// windows showed and files windows opened (a window's state only holds the
// current one). Listens to the services' emitters, not the core's broadcast
// (which does nothing without subscribers).

import path from "node:path";
import type { AppWindow, CommandRun } from "@cmd/protocol";
import type { CommandLog } from "../commands.ts";
import type { WindowManager } from "../windows/manager.ts";
import type { JournalService } from "./service.ts";

/** A page seen again within this long is the same visit (its title arrives after its URL). */
const VISIT_MS = 30 * 60_000;
const FILE_KINDS = new Set(["text", "markdown", "pdf", "files"]);

export function recordCommands(journal: JournalService, commands: CommandLog): void {
  commands.on("updated", (run: CommandRun) => {
    if (run.endedAt === null || !run.command) return;
    journal.record({
      at: run.startedAt,
      until: run.endedAt,
      kind: "command",
      key: `command:${run.id}`,
      spaceId: run.spaceId,
      repo: null,
      cwd: run.cwd,
      thread: `pane:${run.paneId}`,
      text: run.command.split("\n")[0]!.slice(0, 300),
      data: { kind: "command", command: run.command.slice(0, 2000), exitCode: run.exitCode, paneId: run.paneId },
    });
  });
}

export function recordWindows(journal: JournalService, windows: WindowManager): void {
  windows.on("updated", (w: AppWindow) => {
    const now = Date.now();
    if (w.kind === "browser" && typeof w.state.url === "string" && /^https?:/.test(w.state.url)) {
      const url = w.state.url;
      const title = w.title && w.title !== url && w.title !== "Browser" ? w.title : null;
      journal.record({
        at: now,
        until: null,
        kind: "browser.visit",
        key: `visit:${w.id}:${url}:${Math.floor(now / VISIT_MS)}`,
        spaceId: w.spaceId,
        repo: null,
        cwd: null,
        thread: `window:${w.id}`,
        text: title ?? url,
        data: { kind: "browser.visit", url, title, windowId: w.id },
      });
    } else if (FILE_KINDS.has(w.kind) && typeof w.state.path === "string") {
      const p = w.state.path;
      journal.record({
        at: now,
        until: null,
        kind: "file.open",
        key: `file:${w.id}:${p}`,
        spaceId: w.spaceId,
        repo: null,
        cwd: w.kind === "files" ? p : path.dirname(p),
        thread: `window:${w.id}`,
        text: p,
        data: { kind: "file.open", path: p, windowKind: w.kind, windowId: w.id },
      });
    }
  });
}
