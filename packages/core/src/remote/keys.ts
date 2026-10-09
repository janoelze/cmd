// The host's identity for remote access: its static X25519 key (devices pin it
// at pairing) and its routes: one on the relay, one per direct access mode
// (docs/38), so switching modes doesn't reuse a route on another origin. Kept in $CMD_HOME/remote/host.json,
// mode 0600 like secrets.json, so dev and release instances have separate keys
// and devices. TODO: the login Keychain (`security add-generic-password`) first,
// this file as the fallback.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { exportKeyPair, generateKeyPair, importKeyPair, type KeyPair } from "@cmd/remote-crypto";

export interface HostIdentity {
  key: KeyPair;
  /** Set once the relay registered this host. */
  route: string | null;
  secret: string | null;
  /** The relay the route belongs to; another relay means registering again. */
  relay: string | null;
}

interface File {
  key: JsonWebKey;
  route?: string;
  secret?: string;
  relay?: string;
  /** Direct access mode → its route. */
  direct?: Record<string, string>;
}

export class HostKeys {
  readonly #file: string | null;
  #doc: File | null = null;

  /** dir: the instance's remote/ folder; null keeps everything in memory (tests). */
  constructor(dir: string | null) {
    this.#file = dir ? path.join(dir, "host.json") : null;
  }

  async load(): Promise<HostIdentity> {
    if (!this.#doc && this.#file && fs.existsSync(this.#file)) this.#doc = JSON.parse(fs.readFileSync(this.#file, "utf8")) as File;
    if (!this.#doc) {
      this.#doc = { key: await exportKeyPair(await generateKeyPair(true)) };
      this.#save();
    }
    const d = this.#doc;
    return { key: await importKeyPair(d.key), route: d.route ?? null, secret: d.secret ?? null, relay: d.relay ?? null };
  }

  /** The relay route, once loaded: null until a relay registered this host. */
  relayRoute(): { relay: string | null; route: string | null; secret: string | null } {
    if (!this.#doc) throw new Error("host key not loaded");
    return { relay: this.#doc.relay ?? null, route: this.#doc.route ?? null, secret: this.#doc.secret ?? null };
  }

  setRoute(relay: string, route: string, secret: string): void {
    if (!this.#doc) throw new Error("host key not loaded");
    this.#doc = { ...this.#doc, relay, route, secret };
    this.#save();
  }

  /** The route devices dial for a direct access mode (tailscale, url…); made the first time. */
  directRoute(mode: string): string {
    if (!this.#doc) throw new Error("host key not loaded");
    const known = this.#doc.direct?.[mode];
    if (known) return known;
    const route = crypto.randomBytes(16).toString("base64url");
    this.#doc = { ...this.#doc, direct: { ...this.#doc.direct, [mode]: route } };
    this.#save();
    return route;
  }

  #save(): void {
    if (!this.#file || !this.#doc) return;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#doc), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }
}
