// Secrets (API keys, see @cmd/protocol secrets.ts): kept out of settings.json,
// in $CMD_HOME/secrets.json with mode 0600. Values never leave the core: clients
// get status() (set or not, last four characters) and `secrets.updated` events.
// Nothing is read from the environment; a key is used only once the user sets it.

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { isSecretKey, SECRETS, type SecretKey, type SecretsStatus } from "@cmd/protocol";

/** Read the secrets file directly (the `cmd magic` prompt lab runs without a core). */
export function readSecrets(file: string): Partial<Record<SecretKey, string>> {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([k, x]) => isSecretKey(k) && typeof x === "string" && x)) as Partial<Record<SecretKey, string>>;
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
    if (!isSecretKey(key)) throw new Error(`unknown secret "${key}"`);
    const v = value?.trim();
    const next = { ...this.#values };
    if (v) next[key] = v;
    else delete next[key];
    if (this.path) {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      fs.chmodSync(tmp, 0o600); // mode only applies to new files
      fs.renameSync(tmp, this.path);
    }
    this.#values = next;
    const status = this.status();
    this.emit("updated", status);
    return status;
  }
}
