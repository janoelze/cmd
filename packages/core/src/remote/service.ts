// Remote access in the core (docs/13-remote-access.md): follows the remote.*
// settings, keeps one Transport, made by the access mode that remote.access
// names (the relay, Tailscale, your own URL…, docs/38; access/mode.ts), issues
// pairing links, asks the Mac to approve new devices, keeps the device list,
// and runs one HostChannel per connected device. It knows modes only through
// the registry. Sessions are served by the core like socket clients, held to
// policy.ts. Every pairing, session, revoke, denied call and failed handshake is
// logged (scope "remote") and kept in the remote_log table.

import crypto from "node:crypto";
import path from "node:path";
import type { CoreEvent, PaneId, RemoteAccessMode, RemoteDevice, RemoteLogEntry, RemotePairRequest, RemoteScope, RemoteSession, RemoteStatus, SettingKey, Settings } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { encodePairing, equal, fromBase64Url, randomBytes, toBase64Url, type Bytes, type KeyPair } from "@cmd/remote-crypto";
import type { Connection, Served } from "../connection.ts";
import type { SettingsService } from "../settings.ts";
import type { RemoteDeviceRecord, Store } from "../store.ts";
import { exec as loginExec } from "../loginpath.ts";
import { registerBuiltinModes } from "./access/builtin.ts";
import { AccessModes, unknownMode, type AccessMode, type AccessRun, type Check, type ModeContext } from "./access/mode.ts";
import { HostKeys } from "./keys.ts";
import { webClientDir } from "./webroot.ts";
import type { Transport } from "./transport.ts";
import { HostChannel, type ChannelHost } from "./session.ts";

const log = logger("remote");

const PAIRING_TTL_MS = 5 * 60_000;
const APPROVAL_TTL_MS = 2 * 60_000;
/** Failed handshakes per minute before new channels are dropped unread for the rest of it. */
const MAX_FAILURES = 3;
export const REMOTE_VERSION = "1";

export interface RemoteServiceOptions {
  store: Store;
  /** The audit log, as events in the log (remote.audit); none: the log stays in the process (tests). */
  audit?: { record: (kind: string, deviceId: string | null, detail: string | null) => void; list: (limit: number) => { at: number; kind: string; deviceId: string | null; detail: string | null }[] };
  settings: SettingsService;
  /** $CMD_HOME; null keeps the host key in memory (tests). */
  stateDir: string | null;
  serve: (conn: Connection) => Served;
  broadcast: (e: CoreEvent) => void;
  /** The access modes; default: the built-ins. */
  modes?: AccessModes;
  /** How modes run tools (tests fake it); default: loginpath.ts exec. */
  exec?: ModeContext["exec"];
  /** The built web client the direct listener serves; default: webroot.ts. */
  webDir?: string | null;
}

export class RemoteService {
  /** The audit log without an event log (tests). */
  #memoryLog: { at: number; kind: string; deviceId: string | null; detail: string | null }[] = [];
  #o: RemoteServiceOptions;
  #keys: HostKeys;
  #key: KeyPair | null = null;
  #transport: Transport | null = null;
  /** The mode that made the running transport, and its run. */
  #mode: AccessMode | null = null;
  #run: AccessRun | null = null;
  /** The settings the running transport was made from, to skip restarts that change nothing. */
  #config = "";
  #modes: AccessModes;
  #channels = new Map<number, HostChannel>();
  #pairing: { psk: Bytes; scope: RemoteScope; expiresAt: number } | null = null;
  #requests = new Map<string, { request: RemotePairRequest; resolve: (scope: RemoteScope | null) => void }>();
  #failures: number[] = [];
  /** Which session a served connection is. */
  #sessions = new WeakMap<Connection, HostChannel>();
  /** Last remote.input per device and pane (throttle). */
  #inputAt = new Map<string, number>();
  #applying: Promise<void> = Promise.resolve();
  #closed = false;
  #unbind = () => {};
  #unwatchModes: () => void;

  constructor(o: RemoteServiceOptions) {
    this.#o = o;
    this.#keys = new HostKeys(o.stateDir ? path.join(o.stateDir, "remote") : null);
    this.#modes = o.modes ?? builtinModes();
    this.#unwatchModes = this.#modes.onChange(() => this.#bind());
    this.#bind();
  }

  /** Follow every mode's settings (a change to the running one's may restart it); again when a mode is registered. */
  #bind(): void {
    const keys = new Set<SettingKey>(["remote.enabled", "remote.access"]);
    for (const m of this.#modes.all()) for (const k of m.settings) keys.add(k);
    this.#unbind();
    this.#unbind = this.#o.settings.bind([...keys], (s) => this.#apply(s));
  }

  get modes(): AccessModes {
    return this.#modes;
  }

  /** The access modes, for Settings and the CLI (remote.modes). */
  modeList(): RemoteAccessMode[] {
    return this.#modes.info();
  }

  /** Settings changed: start, restart or stop the transport (serialized). */
  #apply(s: Settings): Promise<void> {
    return (this.#applying = this.#applying.then(async () => {
      const mode = this.#modes.get(s["remote.access"]) ?? null;
      const on = s["remote.enabled"] && !this.#closed && !!mode && !mode.missing?.(s);
      const config = on ? JSON.stringify([mode.id, mode.config ? mode.config(s) : mode.settings.map((k) => s[k])]) : "";
      if (config === this.#config && (this.#transport || !config)) return;
      this.#config = config;
      const prev = this.#mode;
      const run = this.#run;
      this.#stop();
      // The same mode again: the old run hands over what still fits (a publication).
      const restart = prev === mode && on;
      const carried = run ? await run.stop({ restart }) : null;
      if (!on) return this.#changed();
      try {
        const id = await this.#keys.load();
        if (this.#closed) return;
        this.#key = id.key;
        const next = mode.start(this.#context(mode.id), restart ? carried : null);
        this.#mode = mode;
        this.#run = next;
        this.#use(next.transport);
      } catch (err) {
        log.error(`remote access could not start: ${(err as Error).message}`);
      }
      this.#changed();
    }));
  }

  /** For mode `id`: selected while it's the one in use and remote access is on. */
  #context(id: string): ModeContext {
    const o = this.#o;
    return {
      get settings() {
        return o.settings.settings;
      },
      get selected() {
        const s = o.settings.settings;
        return s["remote.enabled"] && s["remote.access"] === id;
      },
      exec: o.exec ?? loginExec,
      keys: this.#keys,
      webDir: o.webDir === undefined ? webClientDir() : o.webDir,
      log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
      audit: (kind, detail) => this.audit(kind, null, detail),
    };
  }

  /** "Check Again": the running mode retries what failed (a published mode publishes again); then its checklist. */
  async setup(): Promise<Check[]> {
    const mode = this.#modeOrThrow(this.#o.settings.settings["remote.access"]);
    await this.#applying;
    await this.#keys.load();
    if (this.#mode === mode) await this.#run?.retry?.();
    return (await mode.detect?.(this.#context(mode.id))) ?? [];
  }

  /** The setup checklist of an access mode (default: the current one); empty when it has nothing to set up. */
  async checks(access: string = this.#o.settings.settings["remote.access"]): Promise<Check[]> {
    const mode = this.#modeOrThrow(access);
    if (!mode.detect) return [];
    await this.#keys.load();
    return mode.detect(this.#context(mode.id));
  }

  #modeOrThrow(id: string): AccessMode {
    const mode = this.#modes.get(id);
    if (!mode) throw new Error(unknownMode(id, this.#modes));
    return mode;
  }

  #use(t: Transport): void {
    this.#transport = t;
    t.on("state", () => this.#changed());
    t.on("open", (ch, ip, user) => this.#openChannel(t, ch, ip, user ?? null));
    t.on("data", (ch, b) => this.#channels.get(ch)?.receive(b));
    t.on("close", (ch) => this.#channels.get(ch)?.close());
    t.start();
  }

  #stop(): void {
    if (!this.#transport) return;
    for (const c of this.#channels.values()) c.close();
    this.#transport.close();
    this.#transport = null;
    this.#mode = null;
    this.#run = null;
    this.#pairing = null;
    for (const r of this.#requests.values()) r.resolve(null);
    this.audit("disabled", null, null);
  }

  /** Settle pending setting changes (tests). */
  ready(): Promise<void> {
    return this.#applying;
  }

  status(): RemoteStatus {
    const s = this.#o.settings.settings;
    const mode = this.#modes.get(s["remote.access"]);
    const missing = !s["remote.enabled"] ? null : mode ? (mode.missing?.(s) ?? null) : unknownMode(s["remote.access"], this.#modes);
    return {
      enabled: s["remote.enabled"],
      state: this.#transport ? this.#transport.state : missing ? "error" : s["remote.enabled"] ? "connecting" : "off",
      error: this.#transport ? this.#transport.error : missing,
      access: s["remote.access"],
      address: this.#transport?.endpoint()?.client ?? null,
      devices: this.devices(),
      sessions: this.sessions(),
      requests: [...this.#requests.values()].map((r) => r.request),
    };
  }

  sessions(): RemoteSession[] {
    const names = new Map(this.#o.store.remoteDevices().map((d) => [d.id, d.name]));
    return [...this.#channels.values()]
      .filter((c) => c.open && c.deviceId)
      .map((c) => ({ id: String(c.channel), deviceId: c.deviceId!, name: names.get(c.deviceId!) ?? "Unknown", scope: c.scope!, since: c.since, ip: c.ip, user: c.user, watching: c.watching }));
  }

  /** Close live sessions, one device's or all, without unpairing. */
  disconnect(deviceId?: string): void {
    for (const c of [...this.#channels.values()]) if (!deviceId || c.deviceId === deviceId) c.close();
    this.audit("disconnected", deviceId ?? null, deviceId ? null : "all");
  }

  log(limit = 100): RemoteLogEntry[] {
    const names = new Map(this.#o.store.remoteDevices().map((d) => [d.id, d.name]));
    return (this.#o.audit?.list(Math.min(limit, 500)) ?? this.#memoryLog.slice(-Math.min(limit, 500)).reverse()).map((e) => ({ ...e, device: e.deviceId ? (names.get(e.deviceId) ?? null) : null }));
  }

  /** The device behind a remote connection, by name. */
  nameOf(conn: Connection): string {
    const id = this.#sessions.get(conn)?.deviceId;
    return this.#o.store.remoteDevices().find((d) => d.id === id)?.name ?? "a device";
  }

  /** A remote connection now follows these windows (window.follow). */
  following(conn: Connection, ids: string[]): void {
    const s = this.#sessions.get(conn);
    if (!s) return;
    s.watching = [...ids];
    this.#changed();
  }

  /** A remote connection typed into a pane: tell the Mac, at most once a second per device and pane. */
  input(conn: Connection, paneId: PaneId): void {
    const s = this.#sessions.get(conn);
    if (!s?.deviceId) return;
    const key = `${s.deviceId}:${paneId}`;
    const now = Date.now();
    if (now - (this.#inputAt.get(key) ?? 0) < 1000) return;
    this.#inputAt.set(key, now);
    const name = this.#o.store.remoteDevices().find((d) => d.id === s.deviceId)?.name ?? "Unknown";
    this.#o.broadcast({ type: "remote.input", deviceId: s.deviceId, name, paneId });
  }

  devices(): RemoteDevice[] {
    this.#expire();
    const ttl = this.#ttl();
    const live = new Set([...this.#channels.values()].filter((c) => c.open).map((c) => c.deviceId));
    return this.#o.store.remoteDevices().map((d) => ({
      id: d.id,
      name: d.name,
      scope: d.scope,
      pairedAt: d.pairedAt,
      lastSeenAt: d.lastSeenAt,
      expiresAt: d.lastSeenAt + ttl,
      connected: live.has(d.id),
    }));
  }

  /** A one-time pairing link; replaces any earlier one. */
  pair(scope: RemoteScope): { url: string; expiresAt: number } {
    const t = this.#transport;
    const route = t?.route;
    const m = this.#mode?.messages;
    if (!t || t.state !== "online" || !route || !this.#key) {
      const error = t?.error ?? this.status().error;
      throw new Error(m?.offline?.(error) ?? `Remote access isn't ready${error ? `: ${error}` : "."}`);
    }
    const at = t.endpoint();
    if (!at) throw new Error(m?.noAddress ?? "Remote access has no address yet.");
    const psk = randomBytes(32);
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.#pairing = { psk, scope, expiresAt };
    this.audit("pair-link", null, scope);
    return { url: `${at.client}/pair#${encodePairing({ socket: at.socket, route, hostKey: this.#key.publicKey, psk })}`, expiresAt };
  }

  approve(requestId: string, allow: boolean, scope?: RemoteScope): void {
    const r = this.#requests.get(requestId);
    if (!r) throw new Error("no such pairing request (already answered, or expired)");
    r.resolve(allow ? (scope ?? r.request.scope) : null);
  }

  revoke(id: string): void {
    this.#o.store.deleteRemoteDevice(id);
    for (const c of this.#channels.values()) if (c.deviceId === id) c.close();
    this.audit("revoked", id, null);
    this.#changed();
  }

  setScope(id: string, scope: RemoteScope): RemoteDevice {
    const d = this.#o.store.remoteDevices().find((x) => x.id === id);
    if (!d) throw new Error("no such device");
    this.#o.store.saveRemoteDevice({ ...d, scope });
    // Sessions carry their scope: drop them, the device reconnects with the new one.
    for (const c of this.#channels.values()) if (c.deviceId === id) c.close();
    this.audit("scope", id, scope);
    this.#changed();
    return this.devices().find((x) => x.id === id)!;
  }

  audit(kind: string, deviceId: string | null, detail: string | null): void {
    log.info(`${kind}${deviceId ? ` ${deviceId}` : ""}${detail ? `: ${detail}` : ""}`);
    try {
      if (this.#o.audit) this.#o.audit.record(kind, deviceId, detail);
      else this.#memoryLog.push({ at: Date.now(), kind, deviceId, detail });
    } catch {
      // the store is closed (shutting down)
    }
  }

  close(): void {
    this.#closed = true;
    this.#unbind();
    this.#unwatchModes();
    this.#stop();
  }

  #changed(): void {
    if (!this.#closed) this.#o.broadcast({ type: "remote.updated", status: this.status() });
  }

  #ttl(): number {
    return this.#o.settings.settings["remote.deviceExpiryDays"] * 86400_000;
  }

  #expire(): void {
    const cutoff = Date.now() - this.#ttl();
    for (const d of this.#o.store.remoteDevices()) {
      if (d.lastSeenAt < cutoff) {
        this.#o.store.deleteRemoteDevice(d.id);
        this.audit("expired", d.id, d.name);
      }
    }
  }

  #openChannel(t: Transport, channel: number, ip: string, user: string | null): void {
    const now = Date.now();
    this.#failures = this.#failures.filter((t) => now - t < 60_000);
    if (this.#failures.length >= MAX_FAILURES || !this.#key) return t.closeChannel(channel);
    const session = new HostChannel({
      channel,
      ip,
      user,
      host: this.#channelHost(this.#key),
      send: (b) => t.send(channel, b),
      drop: () => {
        if (this.#channels.get(channel) !== session) return;
        this.#channels.delete(channel);
        t.closeChannel(channel);
        if (session.deviceId) {
          this.audit("session-end", session.deviceId, ip);
          this.#changed();
        }
      },
    });
    this.#channels.set(channel, session);
  }

  #channelHost(key: KeyPair): ChannelHost {
    const store = this.#o.store;
    return {
      key,
      version: REMOTE_VERSION,
      device: (pub) => {
        this.#expire();
        const d = store.remoteDevices().find((x) => equal(fromBase64Url(x.publicKey), pub));
        if (!d) return null;
        store.saveRemoteDevice({ ...d, lastSeenAt: Date.now() });
        return { id: d.id, scope: d.scope };
      },
      takePairing: () => {
        const p = this.#pairing;
        this.#pairing = null; // single use, right or wrong
        return p && p.expiresAt > Date.now() ? p : null;
      },
      approve: (name, words, scope, signal) => this.#ask(name, words, scope, signal),
      addDevice: (name, pub, scope) => {
        const now = Date.now();
        const rec: RemoteDeviceRecord = { id: crypto.randomUUID(), name, scope, publicKey: toBase64Url(pub), pairedAt: now, lastSeenAt: now };
        // The same browser pairing again replaces its old record.
        for (const d of store.remoteDevices()) if (d.publicKey === rec.publicKey) store.deleteRemoteDevice(d.id);
        store.saveRemoteDevice(rec);
        this.audit("paired", rec.id, `${name} (${scope})`);
        return { id: rec.id };
      },
      failed: (reason) => {
        this.#failures.push(Date.now());
        this.audit("handshake-failed", null, reason);
      },
      serve: (conn, session) => {
        this.#sessions.set(conn, session);
        return this.#o.serve(conn);
      },
      opened: (s) => {
        this.audit("session", s.deviceId, `${s.scope} from ${s.ip}`);
        this.#changed();
      },
    };
  }

  /** Ask the person on the Mac (remote.pairRequest → remote.approve). */
  #ask(name: string, words: string[], scope: RemoteScope, signal: AbortSignal): Promise<RemoteScope | null> {
    const request: RemotePairRequest = { requestId: crypto.randomUUID(), name, words, scope, expiresAt: Date.now() + APPROVAL_TTL_MS };
    return new Promise((resolve) => {
      const done = (answer: RemoteScope | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (!this.#requests.delete(request.requestId)) return;
        this.#o.broadcast({ type: "remote.pairEnded", requestId: request.requestId });
        this.#changed();
        if (!answer) this.audit("pair-denied", null, name);
        resolve(answer);
      };
      const abort = () => done(null);
      const timer = setTimeout(abort, APPROVAL_TTL_MS);
      signal.addEventListener("abort", abort);
      this.#requests.set(request.requestId, { request, resolve: done });
      // TODO: also a system notification, so it works with the app in the background.
      this.#o.broadcast({ type: "remote.pairRequest", request });
      this.#changed();
    });
  }
}

function builtinModes(): AccessModes {
  const m = new AccessModes();
  registerBuiltinModes(m);
  return m;
}
