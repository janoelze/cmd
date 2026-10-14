// Configuring a package widget (docs/56, "Configuring a package widget"; widgets/config.ts):
// widget.config merges a window's values, checked against the widget's fields (an unknown key
// or a secret refused, numbers, switches and enums taken from text or refused, null back to the
// default), and the process gets the new `config`; widget.secret sets and removes a secret per
// package and widget (a key that isn't a secret refused), widget.secrets says which are set,
// the next net.fetch uses the new value, and the value is in no log line, event or message.

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AppWindow, CoreEvent, WidgetEntry } from "@cmd/protocol";
import { initLog, logFile } from "@cmd/protocol/node";
import { Core } from "../src/kernel/core.ts";
import { fakeFactory } from "./fake-pty.ts";
import { FakeWidgetRuntime, tmp, until, writePackage } from "./fake-widget-runtime.ts";

const SECRET = "ghp_configsecret_4f9a2b";
const FIELDS = [
  { key: "repo", title: "Repository", type: "string" },
  { key: "limit", title: "Runs", type: "number", default: 10 },
  { key: "failedOnly", title: "Only failures", type: "boolean", default: false },
  { key: "branch", title: "Branch", type: "enum", options: ["main", "dev"], default: "main" },
  { key: "token", title: "Token", type: "string", secret: true, host: "api.example.com" },
];

beforeAll(() => {
  // The core's log as a file, so the test can read every line it wrote.
  process.env.CMD_LOG_DIR = tmp("cmd-config-logs-");
  initLog("core", { level: "debug" });
});

const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close();
});

async function setup() {
  const home = tmp("cmd-widgets-home-");
  const pkgDir = writePackage(home, { config: FIELDS, permissions: { net: ["api.example.com"] } });
  process.env.CMD_WIDGETS_HOME = home;
  const stateDir = tmp("cmd-state-");
  const core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, stateDir });
  delete process.env.CMD_WIDGETS_HOME;
  cores.push(core);
  const rt = new FakeWidgetRuntime(core.widgetTokens);
  core.library.host.configure({ runtime: rt, times: { pingMs: 20, stallMs: 1000, stopAfterMs: 100, restartMs: 5 } });
  const lines: string[] = [];
  core.serve({ access: "local", send: (line) => lines.push(line), close: () => {} }).receive(JSON.stringify({ id: 1, method: "events.subscribe", params: {} }));
  // What net.fetch sends: the Authorization header of each request.
  const sent: (string | null)[] = [];
  core.library.host.fetchImpl = (async (_u: URL, init: RequestInit) => {
    sent.push((init.headers as Record<string, string>).authorization ?? null);
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  core.start();
  await core.scheduler.idle();
  core.library.host.grant("demo");
  const w = (await core.handlers["widget.add"]({ ref: "pkg:demo/main", workspaceId: core.workspaces.home().id })) as AppWindow;
  await until(() => core.library.host.status(w.id)?.state === "running", "the widget running");
  const h = core.handlers;
  const events = () => lines.map((l) => JSON.parse(l) as { method?: string; params?: CoreEvent }).filter((m) => m.method === "event").map((m) => m.params!);
  const entry = () => (h["widget.list"]({}) as WidgetEntry[]).find((e) => e.ref === "pkg:demo/main")!;
  return { core, rt, w, h, lines, events, entry, stateDir, pkgDir, sent };
}

describe("widget.config", () => {
  it("merges values into the window's config, and the process gets them", async () => {
    const { core, rt, w, h } = await setup();
    const p = rt.last;
    expect((await p.next("ready")).config).toEqual({ limit: 10, failedOnly: false, branch: "main" });
    h["widget.config"]({ windowId: w.id, values: { repo: "jan/cmd" } });
    h["widget.config"]({ windowId: w.id, values: { limit: "25", failedOnly: "true", branch: "dev" } });
    expect(core.windows.others().find((x) => x.id === w.id)!.state.config).toEqual({ repo: "jan/cmd", limit: 25, failedOnly: true, branch: "dev" });
    const pushed = await p.next("config", (m) => m.config.branch === "dev");
    expect(pushed.config).toEqual({ repo: "jan/cmd", limit: 25, failedOnly: true, branch: "dev" });
    // null (or "") goes back to the default.
    h["widget.config"]({ windowId: w.id, values: { limit: null, repo: "" } });
    expect((await p.next("config", (m) => !("repo" in m.config))).config).toEqual({ limit: 10, failedOnly: true, branch: "dev" });
  });

  it("refuses an unknown key, a secret, a value that isn't the field's type, and changes nothing then", async () => {
    const { core, w, h } = await setup();
    h["widget.config"]({ windowId: w.id, values: { repo: "jan/cmd" } });
    const config = () => core.windows.others().find((x) => x.id === w.id)!.state.config;
    expect(() => h["widget.config"]({ windowId: w.id, values: { repo: "x", colour: "red" } })).toThrow(/“colour” isn't a setting of Demo/);
    expect(() => h["widget.config"]({ windowId: w.id, values: { token: SECRET } })).toThrow(/Token is a secret/);
    expect(() => h["widget.config"]({ windowId: w.id, values: { limit: "many" } })).toThrow(/Runs: "many" isn't a number/);
    expect(() => h["widget.config"]({ windowId: w.id, values: { branch: "prod" } })).toThrow(/Branch: "prod" isn't one of main, dev/);
    expect(() => h["widget.config"]({ windowId: w.id, values: { failedOnly: "yes" } })).toThrow(/isn't a yes or no/);
    expect(config()).toEqual({ repo: "jan/cmd" });
    expect(() => h["widget.config"]({ windowId: "nope", values: {} })).toThrow(/not a package widget's window/);
  });
});

describe("widget.secret", () => {
  it("sets, lists and removes a secret per package and widget, in the instance's state, not the package", async () => {
    const { h, entry, stateDir, pkgDir } = await setup();
    const before = fs.readdirSync(pkgDir).sort();
    expect(h["widget.secrets"]({ name: "demo", widget: "main" })).toEqual({ set: [] });
    expect(entry()).toMatchObject({ secrets: [], config: expect.arrayContaining([expect.objectContaining({ key: "token", secret: true, host: "api.example.com" })]) });
    h["widget.secret"]({ name: "demo", widget: "main", key: "token", value: SECRET });
    expect(h["widget.secrets"]({ name: "demo", widget: "main" })).toEqual({ set: ["token"] });
    expect(entry().secrets).toEqual(["token"]);
    const file = path.join(stateDir, "widget-packages", "demo", "secrets.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ main: { token: SECRET } });
    expect(fs.readdirSync(pkgDir).sort()).toEqual(before);
    h["widget.secret"]({ name: "demo", widget: "main", key: "token", value: null });
    expect(h["widget.secrets"]({ name: "demo", widget: "main" })).toEqual({ set: [] });
  });

  it("refuses a key that isn't a secret field, and a widget that isn't there", async () => {
    const { h } = await setup();
    expect(() => h["widget.secret"]({ name: "demo", widget: "main", key: "repo", value: "x" })).toThrow(/“repo” isn't a secret of Demo/);
    expect(() => h["widget.secret"]({ name: "demo", widget: "main", key: "other", value: "x" })).toThrow(/isn't a secret/);
    expect(() => h["widget.secret"]({ name: "demo", widget: "nope", key: "token", value: "x" })).toThrow(/no widget nope in package demo/);
  });

  it("reaches the next net.fetch without a restart, and its value is in no log line, event or message", async () => {
    const { rt, w, h, lines, events, sent } = await setup();
    const p = rt.last;
    await p.next("ready");
    const fetchOnce = async (id: number) => {
      p.send({ kind: "call", id, method: "net.fetch", params: ["https://api.example.com/runs", { auth: "token" }] });
      return p.next("result", (m) => m.id === id);
    };
    const unset = await fetchOnce(1);
    expect(unset).toMatchObject({ ok: false, error: { message: "Token isn't set yet. Add it in the widget's settings." } });
    h["widget.secret"]({ name: "demo", widget: "main", key: "token", value: SECRET });
    const ok = await fetchOnce(2);
    expect(ok).toMatchObject({ ok: true, value: { status: 200, body: "ok" } });
    expect(sent).toEqual([`Bearer ${SECRET}`]);
    expect(rt.procs).toHaveLength(1); // not restarted
    h["widget.config"]({ windowId: w.id, values: { repo: "jan/cmd" } });
    await p.next("config");

    const log = fs.readFileSync(logFile()!.path, "utf8");
    expect(log).toContain("widget demo/main: secret token set");
    expect(log).not.toContain(SECRET);
    expect(events().length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(JSON.stringify(p.received)).not.toContain(SECRET);
  });
});
