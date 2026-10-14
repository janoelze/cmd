// What runs a package widget's process (docs/56, "The runtime: a widget process"): Deno, the
// pinned one widgets/deno.ts finds, under lib/sandbox.ts's sandbox-exec profile (writes and the
// network denied but the widgets socket), with Deno's own permissions from the grant: reads of
// the package, the vendored @cmd/widget-api and the granted folders only; the widgets socket;
// no --allow-net, --allow-run or --allow-write beyond the socket; no remote or npm imports; a
// heap limit. The entry is widget-runtime/package-main.ts. Tests use a fake WidgetRuntime.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WidgetPermissions } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import { expandPath } from "../../lib/policy.ts";
import { cleanEnv, sandboxAvailable, sandboxProfile, type SandboxMode } from "../../lib/sandbox.ts";
import { magicDenyPaths } from "../../lib/paths-deny.ts";
import { RUNTIME_DIR } from "../deno.ts";

const log = logger("widgets");

/** The vendored @cmd/widget-api for Deno (scripts/widget-api-bundle.mjs; staged beside the core in the app). */
export const WIDGET_API_BUNDLE = path.resolve(RUNTIME_DIR, "../../widget-api/dist/deno");
export const PACKAGE_MAIN = path.join(RUNTIME_DIR, "package-main.ts");

export interface ProcessSpec {
  name: string;
  version: string;
  widget: string;
  /** The package folder, and the widget's entry in it. */
  dir: string;
  main: string;
  /** declared ∩ granted. */
  permissions: WidgetPermissions;
  /** The widgets socket and this process's token for it. */
  socket: string | null;
  token: string;
  memoryMb: number;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  /** The end of what it printed on stderr (Deno's own errors, a V8 out-of-memory). */
  stderr: string;
}

export interface RuntimeProcess {
  readonly pid: number | null;
  kill(): void;
}

export interface WidgetRuntime {
  /** Start a process; throws with words for the window when it can't (no Deno, no sandbox). */
  start(spec: ProcessSpec, onExit: (e: ExitInfo) => void): RuntimeProcess;
}

export interface DenoRuntimeOptions {
  deno: () => string | null;
  /** Deno's cache of compiled TypeScript. */
  denoDir: string;
  sandbox: () => SandboxMode;
}

/** The deno argv for a spec (without the sandbox around it). */
export function packageArgs(deno: string, spec: ProcessSpec, configFile: string): string[] {
  const home = os.homedir();
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  // The socket as named and as it really is (/var is /private/var): Deno checks the path it's given.
  const socket = spec.socket ? [...new Set([spec.socket, real(spec.socket)])] : [];
  const read = [real(spec.dir), WIDGET_API_BUNDLE, RUNTIME_DIR, configFile, ...spec.permissions.read.map((r) => path.resolve(expandPath(r, home))), ...socket];
  const args = [deno, "run", "--quiet", "--no-prompt", "--no-remote", "--no-npm", "--node-modules-dir=none", `--config=${configFile}`, `--import-map=${path.join(WIDGET_API_BUNDLE, "import-map.json")}`, `--v8-flags=--max-old-space-size=${spec.memoryMb}`, `--allow-read=${read.join(",")}`, "--allow-env=CMD_WIDGET_SOCKET,CMD_WIDGET_TOKEN"];
  // The widgets socket, and nothing else: Deno counts a Unix socket as net ("unix:<path>"), older ones as a write.
  if (socket.length) args.push(`--allow-write=${socket.join(",")}`, `--allow-net=${socket.map((p) => `unix:${p}`).join(",")}`);
  args.push(PACKAGE_MAIN, path.resolve(real(spec.dir), spec.main), spec.name, spec.version, spec.widget);
  return args;
}

export class DenoRuntime implements WidgetRuntime {
  #o: DenoRuntimeOptions;
  constructor(o: DenoRuntimeOptions) {
    this.#o = o;
  }

  start(spec: ProcessSpec, onExit: (e: ExitInfo) => void): RuntimeProcess {
    const deno = this.#o.deno();
    if (!deno) throw new Error("needs Deno, which isn't installed");
    if (!fs.existsSync(path.join(WIDGET_API_BUNDLE, "import-map.json"))) throw new Error("cmd's widget runtime is missing (pnpm install builds it)");
    const mode = this.#o.sandbox();
    if (mode === "required" && !sandboxAvailable()) throw new Error("can't run here: cmd can't sandbox it");
    fs.mkdirSync(this.#o.denoDir, { recursive: true });
    const configFile = path.join(this.#o.denoDir, "widget-package.json");
    const config = JSON.stringify({ compilerOptions: { jsx: "react-jsx", jsxImportSource: "react", strict: true }, lock: false }) + "\n";
    if (!fs.existsSync(configFile) || fs.readFileSync(configFile, "utf8") !== config) fs.writeFileSync(configFile, config);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-widget-"));
    const args = packageArgs(deno, spec, configFile);
    const argv = mode === "required" ? ["/usr/bin/sandbox-exec", "-p", sandboxProfile({ tmp, deny: magicDenyPaths(), writable: [this.#o.denoDir, ...(spec.socket ? [spec.socket] : [])], net: [] }), ...args] : args;
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: tmp,
      env: { ...cleanEnv(process.env), DENO_DIR: this.#o.denoDir, NO_COLOR: "1", DENO_NO_UPDATE_CHECK: "1", TMPDIR: tmp + "/", CMD_WIDGET_TOKEN: spec.token, ...(spec.socket ? { CMD_WIDGET_SOCKET: spec.socket } : {}) },
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (s: string) => {
      stderr = (stderr + s).slice(-4096);
    });
    let ended = false;
    const end = (e: ExitInfo) => {
      if (ended) return;
      ended = true;
      fs.rm(tmp, { recursive: true, force: true }, () => {});
      onExit(e);
    };
    child.on("close", (code, signal) => end({ code, signal, stderr }));
    child.on("error", (err) => end({ code: null, signal: null, stderr: err.message }));
    log.debug(`widget ${spec.name}/${spec.widget} spawned`, { pid: child.pid, sandbox: mode });
    return {
      pid: child.pid ?? null,
      kill: () => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      },
    };
  }
}
