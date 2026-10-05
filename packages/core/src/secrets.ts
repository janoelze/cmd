// Secrets (API keys, see @cmd/protocol secrets.ts): kept out of settings.json,
// in $CMD_HOME/secrets.json with mode 0600. Values never leave the core: clients
// get status() (set or not, last four characters) and `secrets.updated` events.
// Nothing is read from the environment; a key is used only once the user sets it.

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

export class SecretsService extends EventEmitter<{ updated: [SecretsStatus] }> {
  readonly path: string;
  #values: Partial<Record<SecretKey, string>>;

  /** file = null keeps secrets in memory only (tests). */
  constructor(file: string | null) {
    super();
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
    return this.#values[key];
  }

  status(): SecretsStatus {
    return Object.fromEntries(
      (Object.keys(SECRETS) as SecretKey[]).map((k) => {
        const v = this.#values[k];
        return [k, v ? { set: true, hint: v.length > 8 ? `…${v.slice(-4)}` : undefined } : { set: false }];
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
