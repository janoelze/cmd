// Port publishers (docs/38-direct-remote-access.md, "Access modes"): how the
// direct listener's loopback port becomes reachable over HTTPS (Tailscale Serve,
// your own proxy; later cloudflared, ngrok, Funnel). An adapter only publishes a
// port and reports a URL; it never sees channels, keys or policy, so a plugin
// worker could run one. publishedMode() (published.ts) turns one into an
// AccessMode (mode.ts), with the listener, the publishing and its undoing.

import type http from "node:http";
import type { Settings } from "@cmd/protocol";
import type { ExecResult } from "../../loginpath.ts";
import type { AccessModeInfo, Check } from "./mode.ts";

export type { Check };

export interface AdapterContext {
  /** A tool on the login PATH (loginpath.ts exec; a fake in tests). */
  exec(cmd: string, args: string[], o?: { timeout?: number; env?: NodeJS.ProcessEnv }): Promise<ExecResult>;
  readonly settings: Settings;
  /** This mode is the one in use and remote access is on (so a missing publication is still to come). */
  selected: boolean;
  /** The listener's loopback port. */
  port: number;
  /** The route devices dial, for probes of /r/<route>; null before the mode first ran (checks never make one). */
  route: string | null;
  log: { info(msg: string): void; warn(msg: string): void };
}

/** id: the mode it becomes; settings: its own, shown under Connection (remote.port is added for every adapter), a change unpublishes first; connecting: its status line while it publishes. */
export interface AccessAdapter extends AccessModeInfo {
  /** The setup checklist, in order; each ok, todo or error, with what to do. Reads, never changes anything. */
  detect(ctx: AdapterContext): Promise<Check[]>;
  /** Make the port reachable; resolves to the public origin, or throws why not. */
  enable(ctx: AdapterContext & { route: string }): Promise<{ url: string }>;
  /** Undo enable, leaving anything that isn't ours alone. */
  disable(ctx: AdapterContext): Promise<void>;
  /** Who the publisher says is connecting (RemoteSession.user), from a header only it can set; a display hint, never auth. */
  identify?(req: http.IncomingMessage): string | null;
}
