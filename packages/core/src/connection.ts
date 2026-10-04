// A client of the core: the Unix socket (the app, the CLI, hooks) or a remote
// device's encrypted session (remote/session.ts). Core.serve() runs JSON-RPC over
// either; what a connection may call and which events it gets follow its access.

import type { CoreEvent, RemoteScope } from "@cmd/protocol";

export interface Connection {
  /** local: the Unix socket, everything allowed. Otherwise a paired device's scope, checked by remote/policy.ts. */
  readonly access: "local" | RemoteScope;
  /** The paired device behind a remote session. */
  readonly deviceId?: string;
  /** One JSON-RPC message, newline-terminated. */
  send(line: string): void;
  /** Events, when the connection handles them differently from other lines (a remote session coalesces output). */
  event?(e: CoreEvent, line: string): void;
  close(): void;
}

/** What Core.serve() hands back: feed it lines, tell it when the connection is gone. */
export interface Served {
  receive(line: string): void;
  closed(): void;
}
