// Access modes (docs/38-direct-remote-access.md, "Access modes"): every way of
// reaching this Mac (the hosted relay, Tailscale, your own URL…) is a mode,
// registered here through one typed interface, in the style of WindowTypes and
// TranscriptSources. RemoteService knows a mode only by its id (remote.access):
// the mode makes the Transport, runs its own setup checks and says what's
// missing in its own words. Modes that publish the loopback listener are built
// from a narrower AccessAdapter (adapter.ts) by publishedMode() (published.ts).
// A mode holds the state of its run, so each RemoteService gets its own
// (registerBuiltinModes makes fresh ones).

import type { RemoteAccessCheck, RemoteAccessMode, SettingKey, Settings } from "@cmd/protocol";
import type { ExecResult } from "../../loginpath.ts";
import type { HostKeys } from "../keys.ts";
import type { Transport } from "../transport.ts";

export type Check = RemoteAccessCheck;

export interface ModeContext {
  /** The settings now (read when acting: they change while a mode runs). */
  readonly settings: Settings;
  /** A tool on the login PATH (loginpath.ts exec; a fake in tests). */
  exec(cmd: string, args: string[], o?: { timeout?: number; env?: NodeJS.ProcessEnv }): Promise<ExecResult>;
  /** The host's key and routes, loaded. */
  keys: HostKeys;
  /** The built web client a listener serves (webroot.ts); null: none. */
  webDir: string | null;
  log: { info(msg: string): void; warn(msg: string): void };
  /** An entry in the remote access audit log. */
  audit(kind: string, detail: string | null): void;
  /** Stop and start this mode's transport again, resolved once it has started. */
  restart(): Promise<void>;
}

export interface AccessMode {
  /** The remote.access value that picks it. */
  id: string;
  title: string;
  /** SF Symbol name. */
  icon: string;
  description: string;
  /** The settings it uses, in the order Settings → Remote Access shows them under Connection. */
  settings: readonly SettingKey[];
  /** The setting `cmd remote access <id> VALUE` fills (url: remote.url). */
  argument?: SettingKey;
  /** What the running transport depends on: another value restarts it. Default: its settings' values. */
  config?(s: Settings): unknown;
  /** Why it can't start with these settings (the status error), or null. */
  missing?(s: Settings): string | null;
  /** Its status line while the transport connects ("Publishing on your tailnet…"). */
  connecting: string;
  /** What a pairing link needs that isn't there yet: the transport is offline, or has no address. */
  messages?: { offline?(error: string | null): string; noAddress?: string };
  /** The setup checklist, in order; none: nothing to set up. */
  detect?(ctx: ModeContext): Promise<Check[]>;
  /** "Check Again": retry what failed, then the checklist. Default: detect. */
  setup?(ctx: ModeContext): Promise<Check[]>;
  /** The transport; the service starts it. */
  start(ctx: ModeContext): Transport;
  /** After its transport closed. restart: the same mode starts again next (keep what still fits). */
  stop?(ctx: ModeContext, o: { restart: boolean }): Promise<void>;
}

export class AccessModes {
  #modes = new Map<string, AccessMode>();

  register(m: AccessMode): void {
    if (this.#modes.has(m.id)) throw new Error(`access mode already registered: ${m.id}`);
    this.#modes.set(m.id, m);
  }

  get(id: string): AccessMode | undefined {
    return this.#modes.get(id);
  }

  all(): AccessMode[] {
    return [...this.#modes.values()];
  }

  ids(): string[] {
    return [...this.#modes.keys()];
  }

  info(): RemoteAccessMode[] {
    return this.all().map((m) => ({
      id: m.id,
      title: m.title,
      icon: m.icon,
      description: m.description,
      settings: [...m.settings],
      argument: m.argument ?? null,
      setup: !!m.detect,
      connecting: m.connecting,
    }));
  }
}

/** Why remote.access names no mode, with the ids it could name. */
export const unknownMode = (id: string, modes: AccessModes) => `No access mode “${id}”. Pick one of ${modes.ids().join(", ")}.`;
