// cmd's own Deno (widgets/deno.ts installDeno): the pinned download is checked
// (hash, then code signature) before anything lands in the runtime folder, and
// a build on a Mac without Deno asks before downloading it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { bundledDeno, DENO_SHA256, DENO_VERSION, installDeno } from "../src/widgets/deno.ts";
import type { Backend } from "../src/ai/backends.ts";
import { until as untilWhat } from "../../../test/system.ts";

const mac = process.platform === "darwin";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-deno-install-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A zip like Deno's release asset: one executable called deno (here a copy of a signed system binary, or an unsigned script). */
function fixtureZip(signed: boolean): Buffer {
  const dir = fs.mkdtempSync(path.join(tmp, "src-"));
  const bin = path.join(dir, "deno");
  if (signed) fs.copyFileSync("/usr/bin/true", bin);
  else fs.writeFileSync(bin, "#!/bin/sh\necho deno\n");
  fs.chmodSync(bin, 0o755);
  const zip = path.join(tmp, `${path.basename(dir)}.zip`);
  execFileSync("/usr/bin/ditto", ["-c", "-k", bin, zip]);
  return fs.readFileSync(zip);
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
function fakeFetch(bytes: Buffer) {
  const urls: string[] = [];
  const impl = (async (url: string | URL | Request) => (urls.push(String(url)), new Response(new Uint8Array(bytes)))) as typeof fetch;
  return { impl, urls };
}

describe.runIf(mac)("installDeno", () => {
  it("downloads the pinned release, never latest", async () => {
    const { impl, urls } = fakeFetch(Buffer.from("not deno"));
    await expect(installDeno(path.join(tmp, "url"), { fetchImpl: impl })).rejects.toThrow(/doesn't match/);
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    expect(urls).toEqual([`https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-${arch}-apple-darwin.zip`]);
    expect(DENO_SHA256[arch]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a download whose hash doesn't match, and writes nothing", async () => {
    const state = path.join(tmp, "mismatch");
    const zip = fixtureZip(true);
    const { impl } = fakeFetch(zip);
    await expect(installDeno(state, { fetchImpl: impl, sha256: "0".repeat(64) })).rejects.toThrow(/doesn't match Deno/);
    expect(fs.existsSync(path.join(state, "runtime"))).toBe(false);
  });

  it("refuses a binary whose signature doesn't verify, and leaves the runtime folder empty", async () => {
    const state = path.join(tmp, "unsigned");
    const zip = fixtureZip(false);
    const { impl } = fakeFetch(zip);
    await expect(installDeno(state, { fetchImpl: impl, sha256: sha(zip) })).rejects.toThrow(/signature/);
    expect(fs.readdirSync(path.join(state, "runtime"))).toEqual([]);
  });

  it("installs a download whose hash and signature check out", async () => {
    const state = path.join(tmp, "ok");
    const zip = fixtureZip(true);
    const { impl } = fakeFetch(zip);
    const bin = await installDeno(state, { fetchImpl: impl, sha256: sha(zip) });
    expect(bin).toBe(bundledDeno(state));
    expect(fs.statSync(bin).mode & 0o111).toBeTruthy();
    expect(fs.readdirSync(path.join(state, "runtime"))).toEqual(["deno"]);
    expect(fs.readdirSync(path.dirname(bin))).toEqual(["deno"]);
  });
});

describe("a build on a Mac without Deno", () => {
  const until = (cond: () => boolean) => untilWhat("the build's next step", cond);
  const backend: Backend = {
    name: "fake",
    model: "fake-1",
    async run(r) {
      r.onTurn();
      r.onText("Done.");
      return { text: "Done.", model: "fake-1", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    },
  };

  async function setup() {
    const { Core } = await import("../src/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const installs: string[] = [];
    let finish = () => {};
    const installer = (dir: string) => (installs.push(dir), new Promise<string>((res) => (finish = () => res(bundledDeno(dir)))));
    const stateDir = fs.mkdtempSync(path.join(tmp, "core-"));
    const core = new Core({ socketPath: "", dbPath: null, terminals: fakeFactory().factory, pollMs: 0, magicBackend: () => backend, magicPreviewer: null, magicDeno: null, magicInstallDeno: installer, stateDir });
    const steps: string[] = [];
    core.serve({ access: "local", send: (line) => {
      const m = JSON.parse(line) as { method?: string; params?: { type: string; progress?: { type: string; step?: { tool: string } } } };
      if (m.params?.type === "magic.stream" && m.params.progress?.step) steps.push(m.params.progress.step.tool);
    }, close: () => {} }).receive(JSON.stringify({ id: 1, method: "events.subscribe", params: {} }));
    const w = core.handlers["window.open"]({ kind: "magic", input: {} }) as unknown as { id: string };
    const state = () => core.windows.others().find((x) => x.id === w.id)!.state as Record<string, unknown>;
    return { core, id: w.id, state, installs, finish: () => finish(), steps };
  }

  it("asks before downloading, and downloads only on yes", async () => {
    const { core, id, state, installs, finish, steps } = await setup();
    core.handlers["magic.run"]({ id, prompt: "count to three" });
    await until(() => state().askRuntime === true);
    await new Promise((r) => setTimeout(r, 50));
    expect(state().phase).toBe("working");
    expect(installs).toEqual([]);

    // Yes downloads it once, and the build waits for it.
    const answer = core.handlers["magic.installRuntime"]({}) as unknown as Promise<unknown>;
    expect(installs).toHaveLength(1);
    await until(() => steps.includes("install"));
    expect(state()).toMatchObject({ phase: "working" });
    expect(state().askRuntime).toBeUndefined();
    finish();
    await answer;
    await until(() => state().phase !== "working");
    expect(installs).toHaveLength(1);
    await core.close();
  });

  it("asks once: after Not Now, builds go on without asking until Deno is installed", async () => {
    const { core, id, state, installs, finish, steps } = await setup();
    core.handlers["magic.run"]({ id, prompt: "count to three" });
    await until(() => state().askRuntime === true);

    // Not now: the build goes on without it.
    core.handlers["magic.skipRuntime"]({});
    await until(() => state().phase !== "working");
    expect(state().askRuntime).toBeUndefined();
    expect(installs).toEqual([]);
    expect(steps).not.toContain("install");

    // The next build neither asks nor installs (the question would be set as the build starts).
    const seen: unknown[] = [];
    core.handlers["magic.run"]({ id, prompt: "count to four" });
    seen.push(state().askRuntime);
    await until(() => (seen.push(state().askRuntime), state().phase !== "working"));
    expect(seen.every((v) => v === undefined)).toBe(true);
    expect(installs).toEqual([]);

    // Installing (Settings, the Health tab) clears the decline: with Deno still missing, the next build asks again.
    const install = core.handlers["magic.installRuntime"]({}) as unknown as Promise<unknown>;
    finish();
    await install;
    expect(installs).toHaveLength(1);
    core.handlers["magic.run"]({ id, prompt: "count to five" });
    await until(() => state().askRuntime === true);
    core.handlers["magic.cancel"]({ id });
    await until(() => state().phase !== "working");
    expect(installs).toHaveLength(1);
    await core.close();
  });

  it("stops asking when the build is stopped", async () => {
    const { core, id, state, installs } = await setup();
    core.handlers["magic.run"]({ id, prompt: "count" });
    await until(() => state().askRuntime === true);
    core.handlers["magic.cancel"]({ id });
    await until(() => state().phase !== "working");
    expect(state().askRuntime).toBeUndefined();
    expect(state().error).toBe("Stopped.");
    expect(installs).toEqual([]);
    await core.close();
  });
});
