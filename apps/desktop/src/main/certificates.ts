// Certificates Chromium doesn't trust (a company's own CA, a self-signed dev
// server): the load fails and the browser window says so (BrowserView.tsx).
// "Continue Anyway" trusts that host's certificate for good (saved in
// trusted-certificates.json), and only that certificate: another one for the
// same host, a renewal or an impostor, asks again.

import { app, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { cmdHome, logger } from "@cmd/protocol/node";

const log = logger("certs");
const file = () => path.join(cmdHome(), "trusted-certificates.json");
/** Host (with port) → fingerprint of the certificate the person trusted. */
let allowed: Map<string, string> | null = null;
/** Host → fingerprint of the last certificate refused, what "Continue Anyway" trusts. */
const refused = new Map<string, string>();

function trusted(): Map<string, string> {
  if (allowed) return allowed;
  try {
    const saved = JSON.parse(fs.readFileSync(file(), "utf8")) as Record<string, unknown>;
    allowed = new Map(Object.entries(saved).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    allowed = new Map();
  }
  return allowed;
}

function trust(host: string, fingerprint: string): void {
  const all = trusted();
  all.set(host, fingerprint);
  try {
    fs.writeFileSync(file(), JSON.stringify(Object.fromEntries(all), null, 2));
  } catch (e) {
    log.warn(`couldn't save ${file()}: ${(e as Error).message}`);
  }
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
};

export function handleCertificates(): void {
  app.on("certificate-error", (event, _contents, url, error, cert, callback) => {
    const host = hostOf(url);
    if (host && trusted().get(host) === cert.fingerprint) {
      event.preventDefault();
      return callback(true);
    }
    if (host) refused.set(host, cert.fingerprint);
    log.info(`refused ${host ?? url}: ${error} (issuer ${cert.issuerName})`);
    callback(false);
  });
  ipcMain.handle("allow-certificate", (_e, url: unknown) => {
    const host = typeof url === "string" ? hostOf(url) : null;
    const fingerprint = host ? refused.get(host) : undefined;
    if (!host || !fingerprint) return false;
    trust(host, fingerprint);
    log.info(`trusted ${host}`);
    return true;
  });
}
