// Node transport (CLI, Electron preload, tests). Not imported by browser code.

import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { RpcClient, lineSplitter } from "./client.ts";
import { ENV } from "./rpc.ts";

/**
 * Hash of the core + protocol source. The core reports the hash it started with;
 * the app compares it with the current source to detect a core running stale code.
 */
export function sourceBuildId(repoRoot: string): string {
  const h = createHash("sha256");
  for (const dir of ["packages/protocol/src", "packages/core/src"]) {
    const base = path.join(repoRoot, dir);
    const files = (fs.readdirSync(base, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).sort();
    for (const f of files) {
      h.update(path.join(dir, f));
      h.update(fs.readFileSync(path.join(base, f)));
    }
  }
  return h.digest("hex").slice(0, 12);
}

/** State dir: $CMD_HOME, else ~/Library/Application Support/cmd. */
export function cmdHome(): string {
  return process.env.CMD_HOME ?? path.join(os.homedir(), "Library", "Application Support", "cmd");
}

/** $CMD_CONFIG_DIR, else $CMD_HOME (dev isolation), else ~/.config/cmd. */
export function configDir(): string {
  return process.env.CMD_CONFIG_DIR ?? process.env.CMD_HOME ?? path.join(os.homedir(), ".config", "cmd");
}

/**
 * $CMD_SOCKET, else $CMD_HOME/core.sock, else the per-user temp dir. The temp dir
 * (/var/folders/…) stays reachable from sandboxed agents, unlike ~/Library.
 */
export function defaultSocketPath(): string {
  if (process.env[ENV.socket]) return process.env[ENV.socket]!;
  if (process.env.CMD_HOME) return path.join(process.env.CMD_HOME, "core.sock");
  return path.join(os.tmpdir(), "cmd", "core.sock");
}

/**
 * Where a socket path is actually served. Windows has no Unix sockets in the
 * filesystem, so there a path stands for a named pipe derived from it; callers
 * keep passing paths (and $CMD_HOME keeps isolating dev cores).
 */
export function ipcPath(socketPath: string): string {
  if (process.platform !== "win32" || socketPath.startsWith("\\\\.\\pipe\\")) return socketPath;
  const id = createHash("sha256").update(path.resolve(socketPath).toLowerCase()).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\cmd-${id}`;
}

export interface Connection {
  client: RpcClient;
  close(): void;
  closed: Promise<void>;
}

export function connect(socketPath = defaultSocketPath()): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(ipcPath(socketPath));
    sock.setEncoding("utf8");
    const client = new RpcClient((line) => sock.write(line));
    sock.on("data", lineSplitter((l) => client.receive(l)));
    const closed = new Promise<void>((r) =>
      sock.on("close", () => {
        client.fail(new Error("core connection closed"));
        r();
      }),
    );
    sock.once("error", reject);
    sock.once("connect", () => {
      sock.off("error", reject);
      sock.on("error", () => {});
      resolve({ client, close: () => sock.end(), closed });
    });
  });
}
