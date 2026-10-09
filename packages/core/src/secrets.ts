// Secrets (API keys, see @cmd/protocol secrets.ts): kept out of settings.json,
// in $CMD_HOME/secrets.json with mode 0600. Values never leave the core: clients
// get status() (set or not, last four characters) and `secrets.updated` events.
// Nothing is read from the environment, except in development builds, whose
// main.ts passes keys from .env as a fallback (dev-keys.ts): a key set here wins.

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { currentSecretKey, isSecretKey, SECRETS, type SecretKey, type SecretsStatus } from "@cmd/protocol";

/** Read the secrets file directly (the `cmd magic` prompt lab runs without a core). Renamed keys come back under their new name. */
export function readSecrets(file: string): Partial<Record<SecretKey, string>> {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Partial<Record<SecretKey, string>> = {};
    for (const [k, x] of Object.entries(v)) {
      const key = currentSecretKey(k);
      // The new name wins over the old one.
      if (isSecretKey(key) && typeof x === "string" && x && (key === k || !(key in v))) out[key] = x;
    }
    return out;
  } catch {
    return {};
  }
}

export interface DevKeys {
  values: Partial<Record<SecretKey, string>>;
  from: Partial<Record<SecretKey, string>>;
}

export class SecretsService extends EventEmitter<{ updated: [SecretsStatus] }> {
  readonly path: string;
  #values: Partial<Record<SecretKey, string>>;

  /** Development builds' keys from .env (dev-keys.ts), for keys not set here, and where each came from. */
  #fallback: DevKeys;

  /** file = null keeps secrets in memory only (tests). */
  constructor(file: string | null, fallback: DevKeys = { values: {}, from: {} }) {
    super();
    this.#fallback = fallback;
    this.path = file ?? "";
    this.#values = file ? readSecrets(file) : {};
    if (file) this.#migrate(file);
  }

  /** Rewrite a file that still has renamed keys under their new names. */
  #migrate(file: string): void {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      if (Object.keys(raw).every((k) => currentSecretKey(k) === k)) return;
      this.#write(this.#values);
    } catch {}
  }

  #write(values: Partial<Record<SecretKey, string>>): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(values, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // mode only applies to new files
    fs.renameSync(tmp, this.path);
  }

  get(key: SecretKey): string | undefined {
    return this.#values[key] ?? this.#fallback.values[key];
  }

  status(): SecretsStatus {
    return Object.fromEntries(
      (Object.keys(SECRETS) as SecretKey[]).map((k) => {
        const own = this.#values[k];
        const v = own ?? this.#fallback.values[k];
        const hint = v && v.length > 8 ? `…${v.slice(-4)}` : undefined;
        const from = own ? undefined : this.#fallback.from[k];
        return [k, v ? { set: true, hint: from ? `${hint ?? "set"} from ${path.basename(from) === ".env" ? ".env" : from}` : hint } : { set: false }];
      }),
    ) as SecretsStatus;
  }

  /** Store a value (trimmed), or remove it with null or "". */
  set(key: string, value: string | null): SecretsStatus {
    key = currentSecretKey(key);
    if (!isSecretKey(key)) throw new Error(`unknown secret "${key}"`);
    const v = value?.trim();
    const next = { ...this.#values };
    if (v) next[key] = v;
    else delete next[key];
    if (this.path) this.#write(next);
    this.#values = next;
    const status = this.status();
    this.emit("updated", status);
    return status;
  }
}
