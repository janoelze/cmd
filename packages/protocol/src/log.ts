// Logging and crash records for the Node processes (core, Electron main).
// Each process logs to its own file in logDir(): core.log, main.log (with the
// app pages' warnings and errors, scope [renderer]), update.log. Release and
// development builds log to different folders (see instance.ts). Files rotate
// at 5 MB, keeping three.
//
// Crashes are written as JSON files to logDir()/crashes; Electron main sends
// them on (main/crash.ts), so a core that dies still gets reported. Every
// report carries machineId(), a random id made the first time it's needed.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instanceDir, instanceName, machineIdPath } from "./instance.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;
const TAIL = 200;

/**
 * $CMD_LOG_DIR, else $CMD_HOME/logs, else the platform's place for logs:
 * ~/Library/Logs/cmd (or cmd-dev) on macOS, so Console.app shows them, the
 * state dir's logs folder elsewhere.
 */
export function logDir(): string {
  if (process.env.CMD_LOG_DIR) return process.env.CMD_LOG_DIR;
  if (process.env.CMD_HOME) return path.join(process.env.CMD_HOME, "logs");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Logs", instanceDir());
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), instanceDir(), "logs");
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), instanceDir(), "logs");
}

export const crashDir = (): string => path.join(logDir(), "crashes");

export interface Logger {
  debug(msg: string, ...extra: unknown[]): void;
  info(msg: string, ...extra: unknown[]): void;
  warn(msg: string, ...extra: unknown[]): void;
  error(msg: string, ...extra: unknown[]): void;
}

/** A log file with size-based rotation (name.log → name.1.log → … name.3.log). */
export class LogFile {
  readonly path: string;
  #fd: number | null = null;
  #size = 0;
  /** The last lines written, for crash reports. */
  readonly tail: string[] = [];

  constructor(name: string, dir = logDir()) {
    this.path = path.join(dir, `${name}.log`);
  }

  write(text: string): void {
    for (const l of text.split("\n")) this.tail.push(l);
    if (this.tail.length > TAIL) this.tail.splice(0, this.tail.length - TAIL);
    try {
      if (this.#fd === null) this.#open();
      if (this.#size > MAX_BYTES) this.#rotate();
      const buf = Buffer.from(text + "\n");
      fs.writeSync(this.#fd!, buf);
      this.#size += buf.length;
    } catch {
      // A log that can't be written must never take the process down.
    }
  }

  #open(): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    this.#fd = fs.openSync(this.path, "a");
    this.#size = fs.fstatSync(this.#fd).size;
  }

  #rotate(): void {
    fs.closeSync(this.#fd!);
    const base = this.path.slice(0, -".log".length);
    for (let i = KEEP - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${base}.${i}.log`, `${base}.${i + 1}.log`);
      } catch {}
    }
    fs.renameSync(this.path, `${base}.1.log`);
    this.#open();
  }
}

let sink: LogFile | null = null;
let minLevel: LogLevel = (process.env.CMD_LOG_LEVEL as LogLevel) in LEVELS ? (process.env.CMD_LOG_LEVEL as LogLevel) : "info";

/**
 * Send this process's logging to logDir()/<name>.log. Before (and without) it,
 * loggers write warnings and errors to stderr: tests and the CLI.
 */
export function initLog(name: string, opts: { level?: LogLevel } = {}): LogFile {
  sink = new LogFile(name);
  if (opts.level && !process.env.CMD_LOG_LEVEL) minLevel = opts.level;
  return sink;
}

export const logFile = (): LogFile | null => sink;

/** "Error: msg\n    at …" for errors, JSON for objects, the value itself otherwise. */
export function formatValue(v: unknown): string {
  if (v instanceof Error) return v.stack ?? `${v.name}: ${v.message}`;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function formatLine(level: LogLevel, scope: string, msg: string, extra: unknown[], time = new Date()): string {
  const rest = extra.map(formatValue).join(" ");
  return `${time.toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${rest ? ` ${rest}` : ""}`;
}

/** A logger for one part of the process; the scope is shown in brackets. */
export function logger(scope: string): Logger {
  const at = (level: LogLevel) => (msg: string, ...extra: unknown[]) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const line = formatLine(level, scope, msg, extra);
    if (sink) sink.write(line);
    else if (LEVELS[level] >= LEVELS.warn) console.error(line);
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

// ── crashes ──────────────────────────────────────────────

export type CrashProcess = "core" | "ptyhost" | "main" | "renderer" | "gpu" | "utility" | "native";

export interface CrashReport {
  id: string;
  time: string;
  process: CrashProcess;
  /** uncaughtException, unhandledRejection, render-process-gone, minidump, … */
  kind: string;
  message: string;
  stack: string | null;
  /** App version, build hash, OS… (see crashContext). */
  context: Record<string, string>;
  /** The process's last log lines. */
  log: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let cachedId: { file: string; id: string } | null = null;

function readMachineId(file: string): string | null {
  try {
    const s = fs.readFileSync(file, "utf8").trim();
    return UUID.test(s) ? s : null;
  } catch {
    return null;
  }
}

/**
 * A random id for this install, to tell crashes on one machine from the same
 * crash on many. Not derived from the hardware. Made on first use (installs
 * from before it existed get one then) and shared by every process: the core
 * and main may race to make it, and linking a finished temp file means one
 * wins and nobody reads a half-written file. Synchronous, for recordCrash.
 * Null when it can't be stored (read-only home).
 */
export function machineId(): string | null {
  const file = machineIdPath();
  if (cachedId?.file === file) return cachedId.id;
  let id = readMachineId(file);
  if (!id) {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, `${randomUUID()}\n`);
      try {
        fs.linkSync(tmp, file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (!readMachineId(file)) fs.renameSync(tmp, file); // an unreadable id: replace it
      }
      id = readMachineId(file);
    } catch {
      id = null;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  if (id) cachedId = { file, id };
  return id;
}

/** What every report says about where it happened. The app passes its version to the core in $CMD_APP_VERSION. */
export function crashContext(extra: Record<string, string> = {}): Record<string, string> {
  const machine = machineId();
  return {
    version: process.env.CMD_APP_VERSION ?? "unknown",
    channel: instanceName(),
    platform: `${process.platform} ${os.release()} ${process.arch}`,
    ...(machine ? { machine } : {}),
    node: process.versions.node,
    ...(process.versions.electron ? { electron: process.versions.electron } : {}),
    ...extra,
  };
}

/** Write a crash report for main/crash.ts to send. Synchronous: the process may be about to exit. */
export function recordCrash(r: Omit<CrashReport, "id" | "time" | "log" | "context"> & { context?: Record<string, string>; log?: string[] }): string | null {
  const report: CrashReport = {
    id: randomUUID(),
    time: new Date().toISOString(),
    ...r,
    context: crashContext(r.context),
    log: r.log ?? sink?.tail.slice(-100) ?? [],
  };
  try {
    fs.mkdirSync(crashDir(), { recursive: true });
    const file = path.join(crashDir(), `${report.time.replace(/[:.]/g, "-")}-${report.process}-${report.id.slice(0, 8)}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    return file;
  } catch {
    return null;
  }
}

/**
 * Log and record uncaught exceptions and unhandled rejections. An uncaught
 * exception leaves the process in an unknown state; `exitOnException` exits
 * after recording it (the core), otherwise it keeps running (Electron main,
 * where Electron would only show a dialog). Rejections never exit.
 */
export function installCrashHandlers(processName: CrashProcess, opts: { exitOnException: boolean; context?: () => Record<string, string> }): void {
  const log = logger("crash");
  const record = (kind: string, err: unknown) => {
    const e = err instanceof Error ? err : new Error(formatValue(err));
    log.error(kind, e);
    recordCrash({ process: processName, kind, message: `${e.name}: ${e.message}`, stack: e.stack ?? null, context: opts.context?.() });
  };
  process.on("uncaughtException", (err) => {
    record("uncaughtException", err);
    if (opts.exitOnException) process.exit(70);
  });
  process.on("unhandledRejection", (reason) => record("unhandledRejection", reason));
}
