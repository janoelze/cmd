// Port publishers (docs/38-direct-remote-access.md, "Access modes"): how the
// direct listener's loopback port becomes reachable over HTTPS (Tailscale Serve,
// your own proxy; later cloudflared, ngrok, Funnel). An adapter only publishes a
// port and reports a URL; it never sees channels, keys or policy, so a plugin
// worker could run one. publishedMode() (published.ts) turns one into an
// AccessMode (mode.ts), with the listener, the publishing and its undoing.

import type { SettingKey, Settings } from "@cmd/protocol";
import type { ExecResult } from "../../loginpath.ts";
import type { Check } from "./mode.ts";

export type { Check };

export interface AdapterContext {
  /** A tool on the login PATH (loginpath.ts exec; a fake in tests). */
  exec(cmd: string, args: string[], o?: { timeout?: number; env?: NodeJS.ProcessEnv }): Promise<ExecResult>;
  readonly settings: Settings;
  /** The listener's loopback port. */
  port: number;
  /** The route devices dial, for probes of /r/<route>. */
  route: string;
  log: { info(msg: string): void; warn(msg: string): void };
}

export interface AccessAdapter {
  /** The id of the mode it becomes (remote.access). */
  id: string;
  title: string;
  /** SF Symbol name. */
  icon: string;
  description: string;
  /** Its own settings, shown under Connection (remote.port is added for every adapter). A change unpublishes first. */
  settings: readonly SettingKey[];
  /** The setting `cmd remote access <id> VALUE` fills. */
  argument?: SettingKey;
  /** Its status line while it publishes. */
  connecting: string;
  /** The setup checklist, in order; each ok, todo or error, with what to do. */
  detect(ctx: AdapterContext): Promise<Check[]>;
  /** Make the port reachable; resolves to the public origin, or throws why not. */
  enable(ctx: AdapterContext): Promise<{ url: string }>;
  /** Undo enable, leaving anything that isn't ours alone. */
  disable(ctx: AdapterContext): Promise<void>;
}
