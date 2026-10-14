// A package widget's process (docs/56, "The runtime: a widget process"), run by the core's
// widget host (widgets/host/runtime.ts) as
//   deno run … package-main.ts <main> <package> <version> <widget>
// with CMD_WIDGET_SOCKET and CMD_WIDGET_TOKEN in its environment. It says which widget it is on
// the widgets socket (widget.hello with the token, JSON-RPC), and from then on the socket
// carries the widget wire (protocol widget-tree.ts), one JSON message a line: it imports the
// widget's main and runs it on @cmd/widget-api's runtime, console.* going to the core.
// The core's pings ({"ping":n}) are answered here from the event loop, so a loop stuck in
// the widget's code goes unanswered and the core stops the process.
//
// Through node:net, not Deno.connect: Deno.connect reads the server's address back and
// panics when macOS reports it longer than sun_path (see cmd.ts).

import { run } from "@cmd/widget-api/runtime";

const [main, pkg, version, widget] = Deno.args;
const socket = Deno.env.get("CMD_WIDGET_SOCKET");
const token = Deno.env.get("CMD_WIDGET_TOKEN");
if (!main || !pkg || !version || !widget || !socket || !token) {
  console.error("package-main: run by cmd's widget host only");
  Deno.exit(2);
}

const net = await import("node:net");
const sock = net.connect({ path: socket });
await new Promise<void>((resolve, reject) => {
  sock.once("connect", () => resolve());
  sock.once("error", reject);
});
sock.setEncoding("utf8");
sock.on("error", () => Deno.exit(3));
sock.on("close", () => Deno.exit(0));

type Listener = (m: never) => void;
const listeners = new Set<Listener>();
let hello: ((ok: boolean, message?: string) => void) | null = null;
let buf = "";
const write = (m: unknown) => void sock.write(JSON.stringify(m) + "\n");

sock.on("data", (chunk: string) => {
  buf += chunk;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (hello) {
      const done = hello;
      hello = null;
      done(!m.error, (m.error as { message?: string } | undefined)?.message);
      continue;
    }
    if (typeof m.ping === "number") {
      write({ pong: m.ping });
      continue;
    }
    for (const fn of listeners) fn(m as never);
  }
});

const ok = await new Promise<boolean>((resolve) => {
  hello = (good, message) => {
    if (!good) console.error(`package-main: ${message ?? "cmd refused this widget"}`);
    resolve(good);
  };
  write({ jsonrpc: "2.0", id: 1, method: "widget.hello", params: { token } });
});
if (!ok) Deno.exit(4);

const transport = {
  send: (m: unknown) => write(m),
  listen(fn: Listener) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};

const report = (e: unknown) => {
  const err = e instanceof Error ? e : new Error(String(e));
  write({ kind: "error", message: err.message, stack: err.stack ?? null, componentStack: null });
};
globalThis.addEventListener("unhandledrejection", (ev) => {
  ev.preventDefault();
  report((ev as PromiseRejectionEvent).reason);
});
globalThis.addEventListener("error", (ev) => {
  ev.preventDefault();
  report((ev as ErrorEvent).error ?? (ev as ErrorEvent).message);
});

let mod: { default?: unknown };
try {
  mod = await import(new URL(`file://${main}`).href);
} catch (e) {
  report(e);
  // The core sees the exit and says the widget crashed; the error above says why.
  await new Promise((r) => setTimeout(r, 50));
  Deno.exit(1);
}
await run(transport as never, mod.default as never, { package: pkg, version, widget, captureConsole: true });
