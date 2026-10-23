// Node transport (CLI, Electron preload, tests). Not imported by browser code.

import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { RpcClient, RpcError, lineSplitter } from "./client.ts";
import type { CoreHello } from "./version.ts";
import { defaultSocketPath } from "./instance.ts";

export * from "./log.ts";
export * from "./instance.ts";
export * from "./session.ts";

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
  /** What the core said it is (core.hello), or null when not asked or it couldn't say. */
  hello: CoreHello | null;
  close(): void;
  closed: Promise<void>;
}

/**
 * Connect and ask core.hello first, so `client.has()` knows what the core
 * serves. `hello: false` skips the round trip (the hook, which runs per event).
 */
export async function connect(socketPath = defaultSocketPath(), o: { hello?: boolean } = {}): Promise<Connection> {
  const conn = await open(socketPath);
  if (o.hello === false) return conn;
  try {
    conn.hello = await conn.client.hello();
  } catch (err) {
    // A core without core.hello still serves; one that hung up doesn't.
    if (!(err instanceof RpcError)) throw (conn.close(), err);
  }
  return conn;
}

function open(socketPath: string): Promise<Connection> {
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
      resolve({ client, hello: null, close: () => sock.end(), closed });
    });
  });
}
