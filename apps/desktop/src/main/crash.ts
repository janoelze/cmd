// Crash reporting. Every process records crashes as JSON files in crashDir()
// (protocol/log.ts): the core and main for uncaught errors, main for renderers
// and GPU processes that die, renderers through the "renderer-error" IPC, and
// Crashpad writes minidumps for native crashes. Chromium also writes dumps for
// things that aren't crashes, so a minidump is only sent when the app before
// this one didn't quit (main itself crashed); renderer and GPU crashes are
// reported by their events, and their dumps stay in the folder. This module sends them to a
// Discord webhook, from the app only: a core that crashed is reported by
// whichever app is running, or by the next one to start.
//
// The webhook is baked in at build time from $CMD_CRASH_WEBHOOK (a CI secret;
// electron.vite.config.ts), so the URL isn't in the repository. Development
// builds keep reports locally unless $CMD_CRASH_WEBHOOK is set when they run.
// The `diagnostics.crashReports` setting turns sending off. The same crash is
// sent at most once a day.

import { app, crashReporter } from "electron";
import fs from "node:fs";
import path from "node:path";
import { connect, crashContext, crashDir, logger, machineId, recordCrash, type CrashProcess, type CrashReport } from "@cmd/protocol/node";
import { payload, scrub, signature } from "./crash-format.ts";

declare const __CRASH_WEBHOOK__: string;
const BAKED = typeof __CRASH_WEBHOOK__ === "string" ? __CRASH_WEBHOOK__ : "";

const log = logger("crash");
const DEDUPE_MS = 24 * 60 * 60_000;
const MAX_PER_HOUR = 10;
const RETRY_MS = 10 * 60_000;
const KEEP_SENT = 50;
/** Discord rejects larger attachments from webhooks of servers without boosts. */
const MAX_DUMP_BYTES = 8 * 1024 * 1024;

let webhook = "";
/** null until the core has told us the setting; nothing is sent before. */
let enabled: boolean | null = null;
let context: () => Record<string, string> = () => ({});
let flushing = false;
/** When the previous app started, if it didn't quit: its minidumps are main crashes. */
let crashedSince: number | null = null;
let again = false;
let retry: NodeJS.Timeout | undefined;
const sentAt: number[] = [];

const dumpsDir = () => path.join(crashDir(), "dumps");
const sentDir = () => path.join(crashDir(), "sent");
const statePath = () => path.join(crashDir(), "sent.json");

export interface CrashStatus {
  /** Reports leave this machine (a webhook is configured and the setting is on). */
  sending: boolean;
  /** Why not, when not. */
  reason: string | null;
  pending: number;
  folder: string;
}

export function crashStatus(devBuild: boolean): CrashStatus {
  let pending = 0;
  try {
    pending = fs.readdirSync(crashDir()).filter((f) => f.endsWith(".json") && f !== "sent.json").length;
  } catch {}
  const reason = !webhook ? (devBuild ? "Development builds keep crash reports on this Mac." : "This build has no crash report address.") : enabled === false ? "Off in settings." : null;
  return { sending: !reason, reason, pending, folder: crashDir() };
}

/**
 * Before app ready: Crashpad for native crashes (minidumps, kept locally and
 * sent by flush) and the handlers for main's own uncaught errors.
 */
export function startCrashReporting(o: { devBuild: boolean; context: () => Record<string, string> }): void {
  context = o.context;
  webhook = process.env.CMD_CRASH_WEBHOOK || (o.devBuild ? "" : BAKED);
  try {
    fs.mkdirSync(dumpsDir(), { recursive: true });
    app.setPath("crashDumps", dumpsDir());
    crashReporter.start({ uploadToServer: false, compress: false, globalExtra: { channel: o.devBuild ? "dev" : "release" } });
  } catch (err) {
    log.warn("crash reporter didn't start", err);
  }
  machineId(); // made now (also on installs from before it existed), not first inside a crash handler
  // Present at startup: the previous app didn't get to quit.
  const marker = path.join(crashDir(), "app.running");
  try {
    crashedSince = fs.statSync(marker).mtimeMs;
    log.warn("the previous session didn't quit cleanly");
  } catch {}
  try {
    fs.writeFileSync(marker, String(process.pid));
  } catch {}
  app.on("will-quit", () => fs.rmSync(marker, { force: true }));
  // A previous app that died mid-send left its claims behind.
  try {
    for (const f of fs.readdirSync(crashDir())) if (f.endsWith(".sending")) fs.renameSync(path.join(crashDir(), f), path.join(crashDir(), f.slice(0, -".sending".length)));
  } catch {}

  app.on("render-process-gone", (_e, wc, d) => {
    if (d.reason === "clean-exit" || d.reason === "killed") return;
    const url = wc.isDestroyed() ? "" : wc.getURL().replace(/\?.*$/, "");
    record("renderer", "render-process-gone", `Renderer ${d.reason} (exit code ${d.exitCode})`, null, { url });
  });
  app.on("child-process-gone", (_e, d) => {
    if (d.reason === "clean-exit" || d.reason === "killed") return;
    const proc: CrashProcess = d.type === "GPU" ? "gpu" : "utility";
    record(proc, "child-process-gone", `${d.name ?? d.type} ${d.reason} (exit code ${d.exitCode})`, null, { service: d.serviceName ?? "" });
  });
}

/** Record a crash from main's side and send it soon. */
export function record(proc: CrashProcess, kind: string, message: string, stack: string | null, extra: Record<string, string> = {}, logLines?: string[]): void {
  log.error(`${proc} ${kind}: ${message}`, ...(stack ? [`\n${stack}`] : []));
  recordCrash({ process: proc, kind, message, stack, context: { ...context(), ...extra }, log: logLines });
  scheduleFlush(1000);
}

let flushTimer: NodeJS.Timeout | undefined;
function scheduleFlush(ms: number): void {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flush(), ms);
}

/** Follow diagnostics.crashReports and send what is waiting; watch for new reports (e.g. from the core). */
export function followCrashReports(socketPath: string): void {
  const attach = async () => {
    try {
      const conn = await connect(socketPath);
      conn.client.onEvent((e) => {
        if (e.type === "settings.updated") setEnabled(e.snapshot.settings["diagnostics.crashReports"]);
      });
      await conn.client.call("events.subscribe", { types: ["settings.updated"] });
      setEnabled((await conn.client.call("settings.get", {})).settings["diagnostics.crashReports"]);
      conn.closed.then(() => setTimeout(attach, 1000));
    } catch {
      setTimeout(attach, 1000);
    }
  };
  void attach();
  try {
    fs.watch(crashDir(), (_ev, f) => {
      if (f && f.endsWith(".json") && f !== "sent.json") scheduleFlush(2000);
    });
  } catch (err) {
    log.warn("can't watch the crash folder", err);
  }
}

function setEnabled(on: boolean): void {
  const was = enabled;
  enabled = on;
  if (on && was !== true) scheduleFlush(was === null ? 10_000 : 0); // the first one waits until startup is done
}

// ── sending ──────────────────────────────────────────────

interface SentState {
  reports: Record<string, { last: number; count: number }>;
  dumps: string[];
}

function readState(): SentState {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    return { reports: s.reports ?? {}, dumps: s.dumps ?? [] };
  } catch {
    return { reports: {}, dumps: [] };
  }
}

const writeState = (s: SentState) => fs.writeFileSync(statePath(), JSON.stringify(s));

async function flush(): Promise<void> {
  if (!webhook || enabled !== true) return;
  if (flushing) return void (again = true);
  flushing = true;
  clearTimeout(retry);
  try {
    const state = readState();
    const files = fs.readdirSync(crashDir()).filter((f) => f.endsWith(".json") && f !== "sent.json").sort();
    for (const f of files) {
      if (!underRate()) break;
      const ok = await sendReport(path.join(crashDir(), f), state);
      writeState(state);
      if (!ok) return void (retry = setTimeout(() => void flush(), RETRY_MS));
    }
    for (const dump of newDumps(state)) {
      if (!underRate()) break;
      if (!(await sendDump(dump))) return void (retry = setTimeout(() => void flush(), RETRY_MS));
      state.dumps.push(path.basename(dump));
      writeState(state);
    }
    pruneSent();
  } catch (err) {
    log.warn("sending crash reports failed", err);
  } finally {
    flushing = false;
    if (again) (again = false), scheduleFlush(0);
  }
}

function underRate(): boolean {
  const hourAgo = Date.now() - 60 * 60_000;
  while ((sentAt[0] ?? Infinity) < hourAgo) sentAt.shift();
  return sentAt.length < MAX_PER_HOUR;
}

/** Sent, or skipped as a repeat: true. Couldn't send (offline, rejected): false, the report stays. */
async function sendReport(file: string, state: SentState): Promise<boolean> {
  const claimed = `${file}.sending`;
  try {
    fs.renameSync(file, claimed); // another app (or this one) is already on it
  } catch {
    return true;
  }
  let report: CrashReport;
  try {
    report = JSON.parse(fs.readFileSync(claimed, "utf8"));
  } catch {
    fs.rmSync(claimed, { force: true }); // unreadable: nothing to send
    return true;
  }
  // Recorded before reports carried it (an older version, or a core still running old code): same machine.
  const machine = machineId();
  if (machine) report.context = { ...report.context, machine: report.context?.machine ?? machine };
  const sig = signature(report);
  const seen = state.reports[sig];
  if (seen && Date.now() - seen.last < DEDUPE_MS) {
    seen.count++;
    log.info(`not sending ${path.basename(file)}: the same crash was sent ${Math.round((Date.now() - seen.last) / 60_000)} min ago`);
    archive(claimed, file);
    return true;
  }
  const repeats = seen?.count ?? 0;
  const ok = await post(payload(report, repeats), [{ name: "report.json", data: Buffer.from(scrub(JSON.stringify(report, null, 2))), type: "application/json" }]);
  if (!ok) {
    fs.renameSync(claimed, file);
    return false;
  }
  state.reports[sig] = { last: Date.now(), count: 1 };
  archive(claimed, file);
  return true;
}

function archive(claimed: string, file: string): void {
  fs.mkdirSync(sentDir(), { recursive: true });
  fs.renameSync(claimed, path.join(sentDir(), path.basename(file)));
}

function pruneSent(): void {
  try {
    const files = fs.readdirSync(sentDir()).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_SENT))) fs.rmSync(path.join(sentDir(), f), { force: true });
  } catch {}
}

/** Minidumps the previous app wrote before it died, not yet sent. */
function newDumps(state: SentState): string[] {
  const out: string[] = [];
  if (crashedSince === null) return out;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".dmp") && !state.dumps.includes(e.name) && fs.statSync(p).mtimeMs >= crashedSince!) out.push(p);
    }
  };
  walk(dumpsDir());
  return out;
}

async function sendDump(file: string): Promise<boolean> {
  const st = fs.statSync(file);
  const report: CrashReport = {
    id: path.basename(file, ".dmp"),
    time: st.mtime.toISOString(),
    process: "native",
    kind: "minidump",
    message: "The app crashed (native); minidump attached",
    stack: null,
    // Reported by this app: the version may be newer than the one that crashed.
    context: crashContext({ ...context(), size: `${Math.round(st.size / 1024)} KB` }),
    log: [],
  };
  const files = st.size <= MAX_DUMP_BYTES ? [{ name: path.basename(file), data: fs.readFileSync(file), type: "application/octet-stream" }] : [];
  if (!files.length) report.context.note = "minidump too large to attach; it's in the crash folder";
  return post(payload(report, 0), files);
}

async function post(body: unknown, files: { name: string; data: Buffer; type: string }[]): Promise<boolean> {
  const form = new FormData();
  form.append("payload_json", JSON.stringify(body));
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([new Uint8Array(f.data)], { type: f.type }), f.name));
  try {
    const res = await fetch(webhook, { method: "POST", body: form, signal: AbortSignal.timeout(20_000) });
    if (res.status === 429) {
      log.warn("crash report rate limited");
      return false;
    }
    if (!res.ok) {
      log.warn(`crash report rejected: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      return res.status >= 500 ? false : true; // a 4xx won't get better by retrying
    }
    sentAt.push(Date.now());
    return true;
  } catch (err) {
    log.warn(`crash report not sent: ${(err as Error).message}`);
    return false;
  }
}
