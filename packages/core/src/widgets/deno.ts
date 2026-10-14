// Deno for widget packages (docs/56, "The runtime: a widget process"): find it, or install
// cmd's own copy, one pinned Deno release checked against its SHA-256 and code signature
// before it runs (bumping it: DENO_VERSION). DenoSetup is the download as the app asks for
// it: once at a time, shared by everyone waiting, and "Not now" remembered while the core
// runs. How a widget's process runs in it: host/runtime.ts.

import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { logger } from "@cmd/protocol/node";
import { expandPath } from "../lib/paths-deny.ts";

const log = logger("deno");

export const RUNTIME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../widget-runtime");

// ── finding Deno ─────────────────────────────────────────

const CANDIDATES = ["/opt/homebrew/bin/deno", "/usr/local/bin/deno", path.join(os.homedir(), ".deno/bin/deno")];

/** cmd's own copy (installDeno) lives here. */
export function bundledDeno(stateDir: string): string {
  return path.join(stateDir, "runtime", "deno", "deno");
}

/** The Deno to use: the setting, cmd's own copy, PATH, the usual install places; null when there is none. */
export function findDeno(o: { setting?: string; stateDir?: string } = {}): string | null {
  const ok = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (o.setting?.trim()) return ok(expandPath(o.setting.trim())) ? expandPath(o.setting.trim()) : null;
  if (o.stateDir && ok(bundledDeno(o.stateDir))) return bundledDeno(o.stateDir);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) if (dir && ok(path.join(dir, "deno"))) return path.join(dir, "deno");
  return CANDIDATES.find(ok) ?? null;
}

// ── installing cmd's own copy ────────────────────────────

/**
 * The Deno release cmd installs, and the SHA-256 of each Mac asset
 * (deno-<arch>-apple-darwin.zip, as GitHub's release lists it). Bumping it is a
 * reviewed change: new hashes from the release's .sha256sum files, then the
 * widget tests (CI installs this same version through installDeno).
 */
export const DENO_VERSION = "2.9.7";
export const DENO_SHA256: Readonly<Record<"aarch64" | "x86_64", string>> = {
  aarch64: "5cd46d6268f6f78f5d88bdc7159d20bd44cdaa4b3303474839f87ec6fe7ae25c",
  x86_64: "95daaff11c116a52ad54785e7914c8e9c9cdcaba793c5ed929c74ca2d8e6259a",
};

export interface InstallDenoOptions {
  fetchImpl?: typeof fetch;
  /** Tests: the hash to expect instead of DENO_SHA256's. */
  sha256?: string;
}

/**
 * Download the pinned Deno into cmd's state folder (macOS). The zip's hash is
 * checked before anything is written, the binary's signature before it is put
 * in place; either failing leaves the runtime folder as it was. Returns its path.
 */
export async function installDeno(stateDir: string, o: InstallDenoOptions = {}): Promise<string> {
  if (process.platform !== "darwin") throw new Error("Installing Deno is only automatic on macOS; install it from deno.com.");
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const url = `https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-${arch}-apple-darwin.zip`;
  log.info(`downloading Deno ${DENO_VERSION}`, { url });
  const res = await (o.fetchImpl ?? fetch)(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Couldn't download Deno: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const want = o.sha256 ?? DENO_SHA256[arch];
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== want) {
    log.error(`Deno download doesn't match its pinned hash`, { url, want, got, bytes: bytes.length });
    throw new Error(`The Deno download doesn't match Deno ${DENO_VERSION}, so it wasn't installed.`);
  }
  const target = path.dirname(bundledDeno(stateDir));
  const runtime = path.dirname(target);
  fs.mkdirSync(runtime, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(runtime, ".deno-"));
  try {
    const zip = path.join(tmp, "deno.zip");
    fs.writeFileSync(zip, bytes);
    execFileSync("/usr/bin/ditto", ["-x", "-k", zip, tmp]);
    fs.rmSync(zip, { force: true });
    const bin = path.join(tmp, "deno");
    const sig = spawnSync("/usr/bin/codesign", ["-v", bin], { encoding: "utf8", timeout: 30_000 });
    if (sig.status !== 0) {
      log.error(`Deno's code signature doesn't verify`, { url, status: sig.status, stderr: sig.stderr?.trim() });
      throw new Error(`Deno ${DENO_VERSION}'s signature doesn't verify, so it wasn't installed.`);
    }
    fs.chmodSync(bin, 0o755);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  log.info(`installed Deno ${DENO_VERSION}`, { path: bundledDeno(stateDir) });
  return bundledDeno(stateDir);
}

export function denoVersion(deno: string): string | null {
  const r = spawnSync(deno, ["--version"], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? (r.stdout.split("\n")[0] ?? null) : null;
}

// ── the download, as the app asks for it ─────────────────

/** An answer to "Download Deno?": the download under way (yes), or null (not now, or the asker stopped). */
export type DenoAnswer = { install: Promise<unknown> } | null;

export class DenoSetup {
  #stateDir: string | null;
  #install: (stateDir: string) => Promise<string>;
  #installing: Promise<string> | null = null;
  #declined = false;
  #asks = new Set<(a: DenoAnswer) => void>();
  /** After a download: what was waiting for Deno can start (the widget host restarts its windows). */
  onInstalled: () => void = () => {};

  /** The Deno widgets run on now (findDeno, or the one a test picks); null when there is none. */
  readonly find: () => string | null;

  /** `install`: tests inject one; null: this core can't install (no state folder, or a test that picks the Deno). */
  constructor(o: { stateDir: string | null; find: () => string | null; install?: ((stateDir: string) => Promise<string>) | null }) {
    const install = o.install === undefined ? (dir: string) => installDeno(dir) : o.install;
    this.find = o.find;
    this.#stateDir = install ? o.stateDir : null;
    this.#install = install ?? (() => Promise.reject(new Error("no state folder to install Deno into")));
  }

  /** Whether asking makes sense: cmd can download it here. */
  get canInstall(): boolean {
    return !!this.#stateDir;
  }

  /** Wait for the person's answer, after `asking()` puts the question (a build's window); a download under way or an earlier "Not now" answers at once, unasked. */
  ask(signal: AbortSignal, asking: () => void): Promise<DenoAnswer> {
    if (this.#installing) return Promise.resolve({ install: this.#installing });
    if (this.#declined) return Promise.resolve(null);
    asking();
    return new Promise((resolve) => {
      const answer = (a: DenoAnswer) => {
        this.#asks.delete(answer);
        signal.removeEventListener("abort", stop);
        resolve(a);
      };
      const stop = () => answer(null);
      this.#asks.add(answer);
      signal.addEventListener("abort", stop, { once: true });
    });
  }

  /** Whether a build is waiting for the answer. */
  get asking(): boolean {
    return this.#asks.size > 0;
  }

  /** Download it (Settings, a build's yes): one download at a time; everyone waiting gets it. */
  install(): Promise<string> {
    const stateDir = this.#stateDir;
    if (!stateDir) return Promise.reject(new Error("no state folder to install Deno into"));
    this.#declined = false;
    if (!this.#installing) {
      log.info(`installing Deno ${DENO_VERSION}`);
      this.#installing = this.#install(stateDir)
        .then((p) => (this.onInstalled(), p))
        .catch((e: Error) => {
          log.warn(`installing Deno failed: ${e.message}`);
          throw e;
        })
        .finally(() => (this.#installing = null));
      // Builds show the download's error as a step; they don't fail on it.
      this.#installing.catch(() => {});
    }
    for (const answer of [...this.#asks]) answer({ install: this.#installing });
    return this.#installing;
  }

  /** "Not now": the builds waiting go on without it, and later ones don't ask until it's installed. */
  skip(): void {
    this.#declined = true;
    for (const answer of [...this.#asks]) answer(null);
  }
}
