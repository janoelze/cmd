// Access adapter registry (docs/38-direct-remote-access.md): how the direct
// listener's loopback port becomes reachable over HTTPS (Tailscale Serve, your
// own proxy…). An adapter only publishes a port and reports a URL; it never sees
// channels, keys or policy. Built-ins are registered in builtin.ts through the
// same API a plugin host will use, as WindowTypes and TranscriptSources are.

import type { RemoteAccessCheck, Settings } from "@cmd/protocol";
import type { ExecResult } from "../../loginpath.ts";

export interface AdapterContext {
  /** A tool on the login PATH (loginpath.ts exec; a fake in tests). */
  exec(cmd: string, args: string[], o?: { timeout?: number; env?: NodeJS.ProcessEnv }): Promise<ExecResult>;
  settings: Settings;
  /** The listener's loopback port. */
  port: number;
  /** The route devices dial, for probes of /r/<route>. */
  route: string;
  log: { info(msg: string): void; warn(msg: string): void };
}

export type Check = RemoteAccessCheck;

export interface AccessAdapter {
  /** The remote.access value that picks it. */
  id: string;
  title: string;
  /** SF Symbol name. */
  icon: string;
  description: string;
  /** The setup checklist, in order; each ok, todo or error, with what to do. */
  detect(ctx: AdapterContext): Promise<Check[]>;
  /** Make the port reachable; resolves to the public origin, or throws why not. */
  enable(ctx: AdapterContext): Promise<{ url: string }>;
  /** Undo enable, leaving anything that isn't ours alone. */
  disable(ctx: AdapterContext): Promise<void>;
}

export interface AccessAdapterInfo {
  id: string;
  title: string;
  icon: string;
  description: string;
}

export class AccessAdapters {
  #adapters = new Map<string, AccessAdapter>();

  register(a: AccessAdapter): void {
    if (this.#adapters.has(a.id)) throw new Error(`access adapter already registered: ${a.id}`);
    this.#adapters.set(a.id, a);
  }

  get(id: string): AccessAdapter | undefined {
    return this.#adapters.get(id);
  }

  all(): AccessAdapter[] {
    return [...this.#adapters.values()];
  }

  info(): AccessAdapterInfo[] {
    return this.all().map(({ id, title, icon, description }) => ({ id, title, icon, description }));
  }
}
