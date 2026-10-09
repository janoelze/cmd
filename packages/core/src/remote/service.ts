// Remote access in the core (docs/13-remote-access.md): follows the remote.*
// settings, keeps one Transport (the relay link, or the direct listener behind
// an access adapter, docs/38), issues pairing links,
// asks the Mac to approve new devices, keeps the device list, and runs one
// HostChannel per connected device. Sessions are served by the core like socket
// clients, held to policy.ts. Every pairing, session, revoke, denied call and
// failed handshake is logged (scope "remote") and kept in the remote_log table.

import crypto from "node:crypto";
import path from "node:path";
import type { CoreEvent, PaneId, RemoteDevice, RemoteLogEntry, RemotePairRequest, RemoteScope, RemoteSession, RemoteStatus, Settings } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { encodePairing, equal, fromBase64Url, randomBytes, toBase64Url, type Bytes, type KeyPair } from "@cmd/remote-crypto";
import type { Connection, Served } from "../connection.ts";
import type { SettingsService } from "../settings.ts";
import type { RemoteDeviceRecord, Store } from "../store.ts";
import { exec as loginExec } from "../loginpath.ts";
import { AccessAdapters, type AccessAdapter, type AdapterContext, type Check } from "./access/adapter.ts";
import { registerBuiltinAdapters } from "./access/builtin.ts";
import { defaultDirectPort, DirectListener } from "./direct.ts";
import { HostKeys } from "./keys.ts";
import { RelayLink } from "./link.ts";
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
  /** Access adapters for direct modes; default: the built-ins. */
  adapters?: AccessAdapters;
  /** How adapters run tools (tests fake it); default: loginpath.ts exec. */
  exec?: AdapterContext["exec"];
  /** The built web client the direct listener serves; default: webroot.ts. */
  webDir?: string | null;
}

/** The settings that pick and shape the transport. */
const KEYS = ["remote.enabled", "remote.access", "remote.relay", "remote.url", "remote.port", "remote.tailscale.port"] as const;

export class RemoteService {
  /** The audit log without an event log (tests). */
  #memoryLog: { at: number; kind: string; deviceId: string | null; detail: string | null }[] = [];
  #o: RemoteServiceOptions;
  #keys: HostKeys;
  #key: KeyPair | null = null;
  #transport: Transport | null = null;
  /** The settings the running transport was made from, to skip restarts that change nothing. */
  #config = "";
  /** The adapter that published the direct listener, and its context, to undo it when switching away. */
  #published: { adapter: AccessAdapter; ctx: AdapterContext; key: string } | null = null;
  /** The adapter's enable() of the running listener, settled. */
  #enabling: Promise<void> = Promise.resolve();
  #adapters: AccessAdapters;
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
  #unbind: () => void;

  constructor(o: RemoteServiceOptions) {
    this.#o = o;
    this.#keys = new HostKeys(o.stateDir ? path.join(o.stateDir, "remote") : null);
    this.#adapters = o.adapters ?? builtinAdapters();
    this.#unbind = o.settings.bind([...KEYS], (s) => this.#apply(s));
  }

  get adapters(): AccessAdapters {
    return this.#adapters;
  }

  /** Settings changed: start, restart or stop the transport (serialized). */
  #apply(s: Settings): void {
    this.#applying = this.#applying.then(async () => {
      const access = s["remote.access"];
      const config = !s["remote.enabled"] || this.#closed ? "" : JSON.stringify(access === "relay" ? [access, s["remote.relay"].trim()] : KEYS.map((k) => s[k]));
      if (config === this.#config && (this.#transport || !config)) return;
      this.#config = config;
      this.#stop();
      if (this.#published && (!config || this.#published.key !== publishKey(s, this.#localPort(s)))) await this.#unpublish();
      if (!config) return this.#changed();
      try {
        const id = await this.#keys.load();
        if (this.#closed) return;
        this.#key = id.key;
        if (access === "relay") this.#startRelay(s, id);
        else this.#startDirect(s, access);
      } catch (err) {
        log.error(`remote access could not start: ${(err as Error).message}`);
      }
      this.#changed();
    });
  }

  #startRelay(s: Settings, id: { route: string | null; secret: string | null; relay: string | null }): void {
    const relay = s["remote.relay"].trim();
    if (!relay) return;
    // A route belongs to one relay: switching relays registers a new one.
    const same = id.relay === relay;
    const link = new RelayLink({
      relay,
      client: () => this.#o.settings.settings["remote.client"],
      route: same ? id.route : null,
      secret: same ? id.secret : null,
      onRegistered: (route, secret) => this.#keys.setRoute(relay, route, secret),
    });
    this.#use(link);
    this.audit("enabled", null, relay);
  }

  /** The loopback listener, published by the access adapter. */
  #startDirect(s: Settings, access: string): void {
    const adapter = this.#adapters.get(access);
    if (!adapter) throw new Error(`no access adapter "${access}"`);
    const port = this.#localPort(s);
    const route = this.#keys.directRoute(access);
    const listener = new DirectListener({ port, route, webDir: this.#o.webDir === undefined ? webClientDir() : this.#o.webDir });
    this.#use(listener);
    this.audit("enabled", null, `${access} on 127.0.0.1:${port}`);
    const ctx = this.#context(port, route);
    const key = publishKey(s, port);
    this.#enabling = adapter.enable(ctx).then(
      ({ url }) => {
        if (this.#transport === listener) {
          this.#published = { adapter, ctx, key };
          listener.setOrigin(url);
        } else if (!this.#config) {
          // Turned off while it was publishing.
          void adapter.disable(ctx).catch(() => {});
        }
      },
      (err: Error) => {
        log.warn(`${access}: ${err.message}`);
        if (this.#transport === listener) listener.setOrigin(null, err.message);
      },
    );
  }

  async #unpublish(): Promise<void> {
    const p = this.#published;
    this.#published = null;
    try {
      await p?.adapter.disable(p.ctx);
    } catch (err) {
      log.warn(`${p?.adapter.id}: couldn't unpublish: ${(err as Error).message}`);
    }
  }

  #localPort(s: Settings): number {
    return s["remote.port"] || defaultDirectPort();
  }

  #context(port: number, route: string): AdapterContext {
    return {
      exec: this.#o.exec ?? loginExec,
      settings: this.#o.settings.settings,
      port,
      route,
      log: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
    };
  }

  /** "Check Again": a direct mode that isn't online publishes again; then its checklist. */
  async setup(): Promise<Check[]> {
    const s = this.#o.settings.settings;
    if (s["remote.enabled"] && s["remote.access"] !== "relay" && this.#transport?.state !== "online") {
      this.#config = ""; // forces a restart
      this.#apply(s);
      await this.#applying;
      await this.#enabling;
    }
    return this.checks();
  }

  /** The setup checklist of an access mode (default: the current one); the relay has none. */
  async checks(access: string = this.#o.settings.settings["remote.access"]): Promise<Check[]> {
    if (access === "relay") return [];
    const adapter = this.#adapters.get(access);
    if (!adapter) throw new Error(`no access mode "${access}" (try ${this.#adapters.all().map((a) => a.id).join(", ")} or relay)`);
    await this.#keys.load();
    return adapter.detect(this.#context(this.#localPort(this.#o.settings.settings), this.#keys.directRoute(access)));
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
    const relay = s["remote.access"] === "relay";
    const missing = !s["remote.enabled"] ? null : relay ? (s["remote.relay"].trim() ? null : "set a relay (remote.relay)") : this.#adapters.get(s["remote.access"]) ? null : `${s["remote.access"]} isn't available in this version`;
    return {
      enabled: s["remote.enabled"],
      state: this.#transport ? this.#transport.state : missing ? "error" : s["remote.enabled"] ? "connecting" : "off",
      error: this.#transport ? this.#transport.error : missing,
      relay: s["remote.relay"],
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
    const relay = this.#o.settings.settings["remote.access"] === "relay";
    if (!t || t.state !== "online" || !route || !this.#key) throw new Error(relay ? "remote access isn't connected to its relay" : `remote access isn't ready${t?.error ? `: ${t.error}` : ""}`);
    const at = t.endpoint();
    if (!at) throw new Error(relay ? "set the web client's URL first (remote.client)" : "remote access has no address yet");
    const psk = randomBytes(32);
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.#pairing = { psk, scope, expiresAt };
    this.audit("pair-link", null, scope);
    return { url: `${at.client}/pair#${encodePairing({ relay: at.socket, route, hostKey: this.#key.publicKey, psk })}`, expiresAt };
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

function builtinAdapters(): AccessAdapters {
  const a = new AccessAdapters();
  registerBuiltinAdapters(a);
  return a;
}

/** What an adapter published depends on: another value means unpublishing first. */
const publishKey = (s: Settings, port: number) => JSON.stringify([s["remote.access"], port, s["remote.tailscale.port"]]);
