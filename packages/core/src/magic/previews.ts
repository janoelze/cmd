// Who draws a Magic build's trees (docs/56, "Magic on V3"): the app's main process (an
// offscreen window, main/preview.ts) when it said it can (magic.previewer), else Playwright,
// else nobody. A request goes to the app as an event; its answer comes back as magic.previewResult.

import type { CoreEvent, MagicPreviewRequest, MagicPreviewShot, Params } from "@cmd/protocol";
import type { Connection } from "../kernel/connection.ts";
import { playwrightPreviewer, type Previewer } from "./previewer.ts";

export class PreviewBroker {
  /** Tests: who renders (default: the app's connection, else Playwright). */
  #fixed: Previewer | null | undefined;
  /** Connections that render previews (the app's main process), newest last. */
  #conns: Connection[] = [];
  #seq = 0;
  #waits = new Map<string, { resolve: (s: MagicPreviewShot[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #playwright: Promise<Previewer | null> | null = null;

  constructor(fixed?: Previewer | null) {
    this.#fixed = fixed;
  }

  /** `conn` renders previews from now on (the newest one asked first). */
  add(conn: Connection): void {
    this.#conns = [...this.#conns.filter((c) => c !== conn), conn];
  }

  closed(conn: Connection): void {
    this.#conns = this.#conns.filter((c) => c !== conn);
  }

  async previewer(): Promise<Previewer | null> {
    if (this.#fixed !== undefined) return this.#fixed;
    const conn = this.#conns.at(-1);
    if (conn) {
      return {
        name: "app",
        render: (requests: MagicPreviewRequest[]) =>
          new Promise<MagicPreviewShot[]>((resolve, reject) => {
            const reqId = String(++this.#seq);
            const timer = setTimeout(() => {
              this.#waits.delete(reqId);
              reject(new Error("the preview took too long"));
            }, 60_000);
            this.#waits.set(reqId, { resolve, reject, timer });
            conn.send(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "magic.previewRequest", reqId, requests } satisfies CoreEvent }) + "\n");
          }),
      };
    }
    return (this.#playwright ??= playwrightPreviewer());
  }

  /** The app's answer to a request (magic.previewResult). */
  result(p: Params<"magic.previewResult">): void {
    const wait = this.#waits.get(p.reqId);
    if (!wait) return;
    this.#waits.delete(p.reqId);
    clearTimeout(wait.timer);
    if (p.error || !p.shots) wait.reject(new Error(p.error ?? "no shots"));
    else wait.resolve(p.shots);
  }
}
