// loginpath.ts: reading PATH from the login shell (fake shells that are noisy,
// hang or fail, and the real zsh), and merging it with the core's own PATH.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loginShellPath, mergePath } from "../src/loginpath.ts";
import { rmTemp } from "./tmp.ts";

const posix = process.platform !== "win32";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-loginpath-"));
afterAll(() => rmTemp(dir));

/** A "shell" that runs `body`, then its -c command with sh. */
function fakeShell(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\nshift 3\nexec /bin/sh -c "$1"\n`, { mode: 0o755 });
  return file;
}

describe("mergePath", () => {
  const none = () => false;

  it("puts the login shell's dirs before launchd's", () => {
    expect(mergePath("/opt/homebrew/bin:/usr/bin:/bin", "/usr/bin:/bin:/usr/sbin:/sbin", none)).toBe("/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  });

  it("keeps a PATH that already has everything (started from a terminal)", () => {
    expect(mergePath("/opt/homebrew/bin:/usr/bin", "/venv/bin:/opt/homebrew/bin:/usr/bin", none)).toBe("/venv/bin:/opt/homebrew/bin:/usr/bin");
  });

  it("adds the usual install dirs that exist when the shell couldn't be asked", () => {
    const exists = (d: string) => d === "/opt/homebrew/bin";
    expect(mergePath(null, "/usr/bin:/bin", exists)).toBe("/usr/bin:/bin:/opt/homebrew/bin");
  });

  it("drops duplicates and empty entries", () => {
    expect(mergePath("/a::/b:/a", ":/b:/c:", none)).toBe("/a:/b:/c");
  });
});

describe.skipIf(!posix)("loginShellPath", () => {
  it("finds PATH among whatever the rc files print", async () => {
    const shell = fakeShell("noisy", `echo "Welcome back"; echo "${"x".repeat(5000)}"; echo "error: oops" >&2`);
    expect(await loginShellPath(shell, { env: { ...process.env, PATH: "/login/bin:/usr/bin:/bin" } })).toBe("/login/bin:/usr/bin:/bin");
  });

  it("gives up on a shell that hangs", async () => {
    const shell = fakeShell("hangs", "sleep 30");
    const start = Date.now();
    expect(await loginShellPath(shell, { timeoutMs: 300 })).toBeNull();
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("is null for a shell that fails or doesn't exist", async () => {
    expect(await loginShellPath(fakeShell("fails", "exit 1"))).toBeNull();
    expect(await loginShellPath(path.join(dir, "missing"))).toBeNull();
  });

  it.skipIf(!fs.existsSync("/bin/zsh"))("reads it from zsh", async () => {
    const p = await loginShellPath("/bin/zsh", { env: { ...process.env, ZDOTDIR: dir, PATH: "/usr/bin:/bin" } });
    expect(p).toContain("/usr/bin");
  });
});
