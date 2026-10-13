// Reads Now Playing through the MediaRemote adapter (native/mediaremote): macOS only lets
// its own processes read MediaRemote since 15.4, /usr/bin/perl among them, so the adapter
// is a library perl loads (run.pl). `stream` prints a JSON line per change, the first the
// whole state and the rest only what changed (null: a key went away); NowPlayingStream
// keeps the whole and restarts the stream if it dies.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { lineSplitter, type NowPlaying, type NowPlayingCommand } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";

const log = logger("nowplaying");
const NATIVE = path.resolve(import.meta.dirname, "../../native");
const LIB = path.join(NATIVE, "build/libmediaremote.dylib");
const SCRIPT = path.join(NATIVE, "mediaremote/run.pl");
const PERL = "/usr/bin/perl";
/** The adapter's MRACommand ids (MediaRemoteAdapter.h). */
const COMMAND_IDS: Record<NowPlayingCommand, number> = { toggle: 2, next: 4, previous: 5, back15: 12, forward15: 13 };
/** A stream that dies is started again after this, doubling up to RETRY_MAX. */
const RETRY_MS = 1000;
const RETRY_MAX = 60_000;

export const nowPlayingAvailable = () => process.platform === "darwin" && fs.existsSync(LIB) && fs.existsSync(SCRIPT);

type Raw = Record<string, unknown>;

/** The adapter's payload (with --micros) as a NowPlaying; null without a title. */
export function fromRaw(r: Raw): NowPlaying | null {
  const str = (k: string) => (typeof r[k] === "string" && r[k] ? (r[k] as string) : null);
  const num = (k: string) => (typeof r[k] === "number" && Number.isFinite(r[k]) ? (r[k] as number) : null);
  const title = str("title");
  const app = str("bundleIdentifier") ?? str("parentApplicationBundleIdentifier");
  if (!title || !app) return null;
  const duration = num("durationMicros"), elapsed = num("elapsedTimeMicros"), at = num("timestampEpochMicros");
  const art = str("artworkData"), mime = str("artworkMimeType") ?? "image/jpeg";
  return {
    app,
    title,
    artist: str("artist"),
    album: str("album"),
    playing: r.playing === true,
    duration: duration === null || duration <= 0 ? null : duration / 1e6,
    elapsed: elapsed === null ? null : elapsed / 1e6,
    at: at === null ? null : at / 1000,
    rate: num("playbackRate") ?? 1,
    artwork: art ? `data:${mime};base64,${art}` : null,
  };
}

/** The stream, running while anyone wants it (start/stop); "changed" with each new state. */
export class NowPlayingStream extends EventEmitter<{ changed: [NowPlaying | null] }> {
  #child: ChildProcess | null = null;
  #raw: Raw = {};
  #state: NowPlaying | null = null;
  #wanted = false;
  #retry: NodeJS.Timeout | null = null;
  #backoff = RETRY_MS;

  get state(): NowPlaying | null {
    return this.#state;
  }

  start(): void {
    this.#wanted = true;
    if (!this.#child && !this.#retry) this.#spawn();
  }

  stop(): void {
    this.#wanted = false;
    if (this.#retry) clearTimeout(this.#retry), (this.#retry = null);
    this.#child?.kill();
    this.#child = null;
  }

  #spawn(): void {
    if (!nowPlayingAvailable()) return void log.info("adapter not built; Now Playing stays empty");
    const env = { ...process.env, MEDIAREMOTEADAPTER_OPTION_micros: "", MEDIAREMOTEADAPTER_OPTION_debounce: "100" };
    const child = spawn(PERL, [SCRIPT, LIB, "stream"], { stdio: ["ignore", "pipe", "pipe"], env });
    this.#child = child;
    const started = Date.now();
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", lineSplitter((line) => this.#line(line), { max: 32 * 1024 * 1024 }));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => log.warn("adapter:", d.trim().slice(0, 500)));
    child.on("error", (err) => log.warn("adapter failed to start", { err: err.message }));
    child.on("exit", (code, signal) => {
      if (this.#child !== child) return;
      this.#child = null;
      if (!this.#wanted) return;
      // A stream that ran a while starts again quickly; one that dies at once backs off.
      this.#backoff = Date.now() - started > 30_000 ? RETRY_MS : Math.min(RETRY_MAX, this.#backoff * 2);
      log.warn(`adapter exited (${signal ?? code}); again in ${this.#backoff} ms`);
      this.#retry = setTimeout(() => ((this.#retry = null), this.#wanted && this.#spawn()), this.#backoff);
      this.#retry.unref();
    });
  }

  #line(line: string): void {
    let msg: { type?: string; diff?: boolean; payload?: Raw };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type !== "data" || !msg.payload) return;
    if (msg.diff) {
      for (const [k, v] of Object.entries(msg.payload)) v === null ? delete this.#raw[k] : (this.#raw[k] = v);
    } else this.#raw = { ...msg.payload };
    this.#state = fromRaw(this.#raw);
    this.emit("changed", this.#state);
  }
}

/** Send a command (or a seek, in seconds) to what is playing; a short perl run each. */
export function sendNowPlaying(o: { command?: NowPlayingCommand; seek?: number }): Promise<void> {
  if (!nowPlayingAvailable()) return Promise.resolve();
  const args = o.seek !== undefined ? ["seek", String(Math.max(0, Math.round(o.seek * 1e6)))] : o.command ? ["send", String(COMMAND_IDS[o.command])] : null;
  if (!args) return Promise.resolve();
  return new Promise((resolve) => execFile(PERL, [SCRIPT, LIB, ...args], { timeout: 5000 }, (err) => (err && log.warn("adapter command failed", { args, err: err.message }), resolve())));
}
