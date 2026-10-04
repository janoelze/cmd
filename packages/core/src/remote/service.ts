// Remote access in the core (docs/13-remote-access.md): follows the remote.*
// settings, keeps the relay link, issues pairing links, asks the Mac to approve
// new devices, keeps the device list, and runs one HostChannel per connected
// device. Sessions are served by the core like socket clients, held to
// policy.ts. Every pairing, session, revoke, denied call and failed handshake is
// logged (scope "remote") and kept in the remote_log table.

import crypto from "node:crypto";
import path from "node:path";
import type { CoreEvent, RemoteDevice, RemotePairRequest, RemoteScope, RemoteStatus, Settings } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { encodePairing, equal, fromBase64Url, randomBytes, toBase64Url, type Bytes, type KeyPair } from "@cmd/remote-crypto";
import type { Connection, Served } from "../connection.ts";
import type { SettingsService } from "../settings.ts";
import type { RemoteDeviceRecord, Store } from "../store.ts";
import { HostKeys } from "./keys.ts";
import { RelayLink } from "./link.ts";
import { HostChannel, type ChannelHost } from "./session.ts";

const log = logger("remote");

const PAIRING_TTL_MS = 5 * 60_000;
const APPROVAL_TTL_MS = 2 * 60_000;
/** Failed handshakes per minute before new channels are dropped unread for the rest of it. */
const MAX_FAILURES = 3;
export const REMOTE_VERSION = "1";

export interface RemoteServiceOptions {
  store: Store;
  settings: SettingsService;
  /** $CMD_HOME; null keeps the host key in memory (tests). */
  stateDir: string | null;
  serve: (conn: Connection) => Served;
  broadcast: (e: CoreEvent) => void;
}

export class RemoteService {
  #o: RemoteServiceOptions;
  #keys: HostKeys;
  #key: KeyPair | null = null;
  #link: RelayLink | null = null;
  #channels = new Map<number, HostChannel>();
  #pairing: { psk: Bytes; scope: RemoteScope; expiresAt: number } | null = null;
  #requests = new Map<string, { request: RemotePairRequest; resolve: (scope: RemoteScope | null) => void }>();
  #failures: number[] = [];
  #applying: Promise<void> = Promise.resolve();
  #closed = false;
  #unbind: () => void;

  constructor(o: RemoteServiceOptions) {
    this.#o = o;
    this.#keys = new HostKeys(o.stateDir ? path.join(o.stateDir, "remote") : null);
    this.#unbind = o.settings.bind(["remote.enabled", "remote.relay"], (s) => this.#apply(s));
  }

  /** Settings changed: start, restart or stop the relay link (serialized). */
  #apply(s: Settings): void {
    this.#applying = this.#applying.then(async () => {
      this.#stop();
      if (this.#closed || !s["remote.enabled"]) return this.#changed();
      const relay = s["remote.relay"].trim();
      if (!relay) return this.#changed();
      try {
        const id = await this.#keys.load();
        if (this.#closed) return;
        this.#key = id.key;
        // A route belongs to one relay: switching relays registers a new one.
        const same = id.relay === relay;
        const link = new RelayLink({
          relay,
          route: same ? id.route : null,
          secret: same ? id.secret : null,
          onRegistered: (route, secret) => this.#keys.setRoute(relay, route, secret),
        });
        this.#link = link;
        link.on("state", () => this.#changed());
        link.on("open", (ch, ip) => this.#openChannel(link, ch, ip));
        link.on("data", (ch, b) => this.#channels.get(ch)?.receive(b));
        link.on("close", (ch) => this.#channels.get(ch)?.close());
        link.start();
        this.audit("enabled", null, relay);
      } catch (err) {
        log.error(`remote access could not start: ${(err as Error).message}`);
      }
      this.#changed();
    });
  }

  #stop(): void {
    if (!this.#link) return;
    for (const c of this.#channels.values()) c.close();
    this.#link.close();
    this.#link = null;
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
    const noRelay = s["remote.enabled"] && !s["remote.relay"].trim();
    return {
      enabled: s["remote.enabled"],
      state: this.#link ? this.#link.state : noRelay ? "error" : s["remote.enabled"] ? "connecting" : "off",
      error: this.#link ? this.#link.error : noRelay ? "set a relay (remote.relay)" : null,
      relay: s["remote.relay"],
      devices: this.devices(),
    };
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
    const s = this.#o.settings.settings;
    const route = this.#link?.route;
    if (!this.#link || this.#link.state !== "online" || !route || !this.#key) throw new Error("remote access isn't connected to its relay");
    const client = s["remote.client"].trim().replace(/\/+$/, "");
    if (!client) throw new Error("set the web client's URL first (remote.client)");
    const psk = randomBytes(32);
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.#pairing = { psk, scope, expiresAt };
    this.audit("pair-link", null, scope);
    return { url: `${client}/pair#${encodePairing({ relay: s["remote.relay"].trim(), route, hostKey: this.#key.publicKey, psk })}`, expiresAt };
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
      this.#o.store.logRemote(kind, deviceId, detail);
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

  #openChannel(link: RelayLink, channel: number, ip: string): void {
    const now = Date.now();
    this.#failures = this.#failures.filter((t) => now - t < 60_000);
    if (this.#failures.length >= MAX_FAILURES || !this.#key) return link.closeChannel(channel);
    const session = new HostChannel({
      channel,
      ip,
      host: this.#channelHost(this.#key),
      send: (b) => link.send(channel, b),
      drop: () => {
        if (this.#channels.get(channel) !== session) return;
        this.#channels.delete(channel);
        link.closeChannel(channel);
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
      serve: (conn) => this.#o.serve(conn),
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
        if (!answer) this.audit("pair-denied", null, name);
        resolve(answer);
      };
      const abort = () => done(null);
      const timer = setTimeout(abort, APPROVAL_TTL_MS);
      signal.addEventListener("abort", abort);
      this.#requests.set(request.requestId, { request, resolve: done });
      // TODO: also a system notification, so it works with the app in the background.
      this.#o.broadcast({ type: "remote.pairRequest", request });
    });
  }
}
