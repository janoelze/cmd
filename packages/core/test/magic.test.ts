import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classify, credentialsFor, credentialsForPrograms, redact, sandboxProfile, execCommand, fastRoute, runTool, sandboxAvailable, widgetHtml } from "../src/magic/index.ts";
import { lintBody } from "../src/magic/lint.ts";
import { requestedMedia, widgetCsp } from "@cmd/protocol";

const home = "/Users/test";
// Shell commands (the run tool, command sources, the sandbox) are POSIX-only for now.
const posix = process.platform !== "win32";
const level = (cmd: string) => classify(cmd, { home }).level;

describe("command policy", () => {
  it("allows read-only commands and pipelines", () => {
    for (const c of [
      "ls -la ~/src",
      "scutil --nc list",
      "ps -Ao pid,pcpu,comm -r | head -10",
      "df -k / | tail -1 | awk '{print $4}'",
      "git -C ~/src/cmd status --porcelain",
      "curl -s https://api.ipify.org?format=json | jq .ip",
      "ifconfig utun3",
      "pmset -g batt",
      "networksetup -getairportnetwork en0",
      "FOO=1 ls",
      "grep -c x file 2>/dev/null",
      "ls 2>&1 | head",
      "docker stats --no-stream",
      "{ ifconfig | grep inet; netstat -rn; } 2>/dev/null",
      "(cd ~/src && ls) | head",
      "echo '{\"a\": 1}' | jq .a",
    ]) {
      expect([c, level(c)]).toEqual([c, "allow"]);
    }
  });

  it("asks for writes, unknown programs and substitutions", () => {
    for (const c of ["rm -rf /tmp/x", "ls > out.txt", "echo $(whoami)", "echo `id`", "sed -i '' s/a/b/ f", "curl -o x https://a", "curl -X POST https://a", "git push", "find . -delete", "sort -o f f", "top", "ifconfig en0 down", "make"]) {
      expect([c, level(c)]).toEqual([c, "ask"]);
    }
  });

  it("denies privilege, secrets and private paths", () => {
    for (const c of ["sudo wg show", "security find-generic-password -s x", "env", "printenv", "osascript -e 1", "cat ~/.ssh/id_ed25519", "ls /Users/test/.aws", "cat < ~/.netrc", "ls | xargs rm", "python3 -c 1", "cat .env", "cat .ssh/config", "grep x --file=/Users/test/.netrc"]) {
      expect([c, level(c)]).toEqual([c, "deny"]);
    }
    expect(level("ls; sudo ls")).toBe("deny");
    expect(level("{ ls; sudo ls; }")).toBe("deny");
    expect(level("(rm -rf x)")).toBe("ask");
  });
});

describe("logged-in CLIs", () => {
  it("allows read-only gh and glab, never their tokens", () => {
    for (const c of ["gh run list --json status,name --limit 20", "gh pr list", "gh auth status", "gh api repos/a/b/actions/runs", "glab ci list --output json", "glab auth status", "glab api projects/1/pipelines"]) {
      expect([c, level(c)]).toEqual([c, "allow"]);
    }
    for (const c of ["gh auth token", "gh auth status --show-token", "gh run watch 1", "gh pr merge 1", "gh api -X POST repos/a/b/issues", "glab auth status -t", "glab config get token", "glab ci view", "glab ci retry 1"]) {
      expect([c, level(c)]).toEqual([c, "ask"]);
    }
  });

  it("knows which logins a command uses", () => {
    expect(credentialsFor("gh run list | jq length")).toMatchObject({ keychain: true, paths: ["~/.config/gh"] });
    expect(credentialsFor("GH_HOST=x glab ci list").env).toContain("GITLAB_TOKEN");
    expect(credentialsFor("echo gh")).toEqual({ env: [], paths: [], keychain: false });
    expect(credentialsForPrograms(["git", "/opt/homebrew/bin/gh"])).toMatchObject({ keychain: true, paths: ["~/.config/gh"] });
  });

  it.skipIf(!posix)("opens only those logins in the sandbox profile", () => {
    const deny = ["~/.ssh", "~/.config/gh", "~/Library/Keychains"];
    const plain = sandboxProfile({ tmp: "/tmp/x", deny, home });
    expect(plain).toContain(`(subpath "${home}/.config/gh")`);
    expect(plain).toContain('(literal "/usr/bin/security")');
    const gh = sandboxProfile({ tmp: "/tmp/x", deny, home, credentials: credentialsFor("gh pr list") });
    expect(gh).toContain(`(subpath "${home}/.ssh")`);
    expect(gh.match(/\(deny file-read\*[^\n]*/)![0]).not.toContain(".config/gh");
    expect(gh).not.toContain("Keychains");
    expect(gh).not.toContain('(literal "/usr/bin/security")');
  });

  it("scrubs tokens from output", () => {
    const out = redact("token: gho_abcdefghijklmnopqrstuvwxyz0123456789AB\nGITLAB=glpat-abcdefghijklmnopqrstu\napi_key=supersecretvalue123 ok");
    expect(out).not.toMatch(/gho_|glpat-|supersecret/);
    expect(out).toContain("ok");
    expect(redact("run 12345 succeeded on main")).toBe("run 12345 succeeded on main");
  });
});

describe("widget frame CSP", () => {
  it("builds the frame CSP from allowed media origins", () => {
    expect(widgetCsp()).toContain("media-src data:;");
    const csp = widgetCsp(["https://a.example/x", "http://b.example", "javascript:alert(1)"]);
    expect(csp).toContain("media-src data: https://a.example;");
    expect(csp).toContain("img-src data: https://a.example;");
    expect(csp).toContain("connect-src 'none'");
    expect(requestedMedia({ html: '<audio></audio><script>const u="https://r.example/live.aacp"</script>' })).toEqual(["https://r.example"]);
    expect(requestedMedia({ html: '<a href="https://r.example">x</a>' })).toEqual([]);
    expect(requestedMedia({ media: [], html: "<audio src='https://r.example/x'>" })).toEqual([]);
  });
});

describe("fast paths", () => {
  it("routes pasted JSON and obvious commands", () => {
    expect(fastRoute('{"a": [1, 2]}')).toEqual({ route: "json", data: { a: [1, 2] } });
    if (posix) {
      expect(fastRoute("ps aux | head")).toEqual({ route: "terminal", command: "ps aux | head" });
      expect(fastRoute("ls -la")).toEqual({ route: "terminal", command: "ls -la" });
    }
    expect(fastRoute("show my vpn status")).toBeNull();
    expect(fastRoute("weather in Berlin")).toBeNull();
    expect(fastRoute("git status of every repo in ~/src")).toBeNull();
    if (posix) expect(fastRoute("top")).toEqual({ route: "terminal", command: "top" });
  });
});

describe("tools", () => {
  const ctx = (cwd: string) => ({ cwd, home: cwd, deny: ["~/secret"], sandbox: "off" as const });

  it("reads and lists, but not private paths", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-"));
    fs.mkdirSync(path.join(dir, "secret"));
    fs.writeFileSync(path.join(dir, "secret", "key"), "x");
    fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\nthree");
    fs.writeFileSync(path.join(dir, ".env"), "TOKEN=1");
    expect(await runTool("read", { why: "", path: "a.txt", from: 2, to: 2 }, ctx(dir))).toEqual({ output: "two", isError: false });
    expect((await runTool("read", { why: "", path: "~/secret/key" }, ctx(dir))).isError).toBe(true);
    expect((await runTool("read", { why: "", path: ".env" }, ctx(dir))).isError).toBe(true);
    expect((await runTool("list", { why: "", path: "secret" }, ctx(dir))).isError).toBe(true);
    const list = await runTool("list", { why: "", path: "." }, ctx(dir));
    expect(list.output).toContain("d  secret/");
    expect(list.output).toContain("f  a.txt  13");
  });

  it.skipIf(!posix)("runs only read-only commands", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-"));
    expect((await runTool("run", { why: "", command: "touch x" }, ctx(dir))).output).toMatch(/^Not run/);
    const r = await runTool("run", { why: "", command: "echo hi | tr a-z A-Z" }, ctx(dir));
    expect(r).toEqual({ output: "exit 0\nHI\n", isError: false });
  });

});

describe("sandbox", () => {
  it.skipIf(!sandboxAvailable())("blocks writes and private reads", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-sb-"));
    fs.writeFileSync(path.join(dir, "private"), "secret");
    const w = await execCommand(`echo x > ${dir}/out`, { sandbox: "required", deny: [] });
    expect(w.code).not.toBe(0);
    expect(fs.existsSync(path.join(dir, "out"))).toBe(false);
    const r = await execCommand(`cat ${dir}/private`, { sandbox: "required", deny: [dir] });
    expect(r.code).not.toBe(0);
    const ok = await execCommand("echo fine", { sandbox: "required", deny: [] });
    expect(ok.stdout).toBe("fine\n");
  });

  it("refuses to run when it can't sandbox", async () => {
    if (sandboxAvailable()) return;
    const r = await execCommand("echo x", { sandbox: "required" });
    expect(r.code).toBeNull();
    expect(r.stderr).toMatch(/sandbox|Windows/);
  });
});

describe("widget page and lint", () => {
  it("inlines data safely", () => {
    const html = widgetHtml({ title: "<x>", body: "<p>", tokens: { "--bg": "#000" }, data: { s: "</script><b>" } });
    expect(html).toContain("<title>&lt;x&gt;</title>");
    expect(html).not.toContain("</script><b>");
    expect(html).toContain("--bg: #000;");
  });

  it("finds literal colours but not id selectors", () => {
    expect(lintBody("<style>#add{color:var(--text)}</style>").literalColors).toEqual([]);
    expect(lintBody("<style>.a{color: #fff}</style><script>e.style.color='#0a84ff'</script>").literalColors).toEqual(["#fff", "#0a84ff"]);
    expect(lintBody("<div style='background:rgb(0 0 0)'>").literalColors).toEqual(["rgb("]);
  });
});
