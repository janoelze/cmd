import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { classify, credentialsFor, credentialsForPrograms, redact, sandboxProfile, execCommand, fastRoute, runTool, sandboxAvailable, widgetHtml } from "../src/magic/index.ts";
import { lintBody } from "../src/magic/lint.ts";
import { magicDenyPaths, magicPrivatePaths, realPathOf } from "../src/paths-deny.ts";
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
    expect(list.output).not.toContain("secret");
    expect(list.output).not.toContain(".env");
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

describe("cmd's own secrets (AR1-11-11)", () => {
  // A temp instance: secrets, the host key, settings and the database beside a widget.
  const saved = { home: process.env.CMD_HOME, config: process.env.CMD_CONFIG_DIR, logs: process.env.CMD_LOG_DIR };
  let cmdHome = "";
  let widget = "";
  beforeAll(() => {
    cmdHome = fs.mkdtempSync(path.join(os.tmpdir(), "magic-home-"));
    process.env.CMD_HOME = cmdHome;
    delete process.env.CMD_CONFIG_DIR;
    delete process.env.CMD_LOG_DIR;
    fs.writeFileSync(path.join(cmdHome, "secrets.json"), '{"ai.anthropic.apiKey":"sk-ant-secret"}');
    fs.writeFileSync(path.join(cmdHome, "widget-secrets.json"), "{}");
    fs.writeFileSync(path.join(cmdHome, "settings.json"), "{}");
    fs.writeFileSync(path.join(cmdHome, "cmd.sqlite"), "db");
    fs.mkdirSync(path.join(cmdHome, "remote"));
    fs.writeFileSync(path.join(cmdHome, "remote", "host.json"), '{"secretKey":"x"}');
    fs.mkdirSync(path.join(cmdHome, "data"));
    widget = path.join(cmdHome, "widgets", "w1");
    fs.mkdirSync(path.join(widget, "fixtures"), { recursive: true });
    fs.writeFileSync(path.join(widget, "data.ts"), "export default () => 1;");
    fs.mkdirSync(path.join(cmdHome, "runtime", "deno-cache"), { recursive: true });
  });
  afterAll(() => {
    for (const [k, v] of [["CMD_HOME", saved.home], ["CMD_CONFIG_DIR", saved.config], ["CMD_LOG_DIR", saved.logs]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const ctx = (cwd: string) => ({ cwd, home: os.homedir(), deny: magicDenyPaths(), sandbox: "off" as const });

  it("lists the private files of every instance, ~/.config/cmd and the logs, not the state dir", () => {
    const p = magicPrivatePaths();
    expect(p).toContain("~/.config/cmd");
    expect(p).toContain("~/Library/Logs/cmd");
    expect(p).toContain(path.join(cmdHome, "logs"));
    for (const f of ["secrets.json", "widget-secrets.json", "remote", "settings.json", "cmd.sqlite", "cmd.sqlite-wal", "data"]) expect(p).toContain(path.join(cmdHome, f));
    for (const d of ["cmd", "cmd-dev"]) expect(p).toContain(path.join(os.homedir(), "Library", "Application Support", d, "secrets.json"));
    expect(p).not.toContain(cmdHome);
    expect(p.some((x) => x.includes(`${path.sep}widgets`) || x.includes(`${path.sep}runtime`))).toBe(false);
  });

  it("read refuses secrets.json and the host key, reads a widget's data.ts", async () => {
    for (const f of ["secrets.json", "remote/host.json", "settings.json", "cmd.sqlite", "widget-secrets.json"]) {
      const r = await runTool("read", { why: "", path: path.join(cmdHome, f) }, ctx(widget));
      expect(r.isError, f).toBe(true);
      expect(r.output, f).toMatch(/is private/);
    }
    expect(await runTool("read", { why: "", path: "data.ts" }, ctx(widget))).toEqual({ output: "export default () => 1;", isError: false });
    expect((await runTool("read", { why: "", path: path.join(widget, "data.ts") }, ctx(os.homedir()))).isError).toBe(false);
  });

  it("list hides them in the state dir and refuses their folders", async () => {
    const r = await runTool("list", { why: "", path: cmdHome }, ctx(widget));
    expect(r.isError).toBe(false);
    expect(r.output).toContain("d  widgets/");
    expect(r.output).toContain("d  runtime/");
    for (const f of ["secrets.json", "remote", "settings.json", "cmd.sqlite", "data", "widget-secrets.json"]) expect(r.output).not.toContain(`  ${f}`);
    expect((await runTool("list", { why: "", path: path.join(cmdHome, "remote") }, ctx(widget))).output).toMatch(/is private/);
    expect((await runTool("list", { why: "", path: "fixtures" }, ctx(widget))).isError).toBe(false);
  });

  it("follows symlinks, and knows worktree instances by name", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magic-link-"));
    fs.symlinkSync(path.join(cmdHome, "secrets.json"), path.join(dir, "innocent.txt"));
    expect((await runTool("read", { why: "", path: "innocent.txt" }, ctx(dir))).output).toMatch(/is private/);
    const tree = path.join(dir, "cmd-topic", ".cmd-dev");
    fs.mkdirSync(path.join(tree, "remote"), { recursive: true });
    fs.mkdirSync(path.join(tree, "widgets"));
    fs.writeFileSync(path.join(tree, "secrets.json"), "{}");
    fs.writeFileSync(path.join(tree, "remote", "host.json"), "{}");
    fs.writeFileSync(path.join(tree, "widgets", "data.ts"), "x");
    expect((await runTool("read", { why: "", path: path.join(tree, "secrets.json") }, ctx(dir))).output).toMatch(/is private/);
    expect((await runTool("read", { why: "", path: path.join(tree, "remote", "host.json") }, ctx(dir))).output).toMatch(/is private/);
    expect((await runTool("read", { why: "", path: path.join(tree, "widgets", "data.ts") }, ctx(dir))).isError).toBe(false);
    expect(classify(`cat ${path.join(tree, "secrets.json")}`, { deny: magicDenyPaths() }).level).toBe("deny");
    expect(classify(`cat ${path.join(cmdHome, "secrets.json")}`, { deny: magicDenyPaths() }).level).toBe("deny");
  });

  it("the sandbox profile denies the same files by real path, not the widgets", () => {
    const profile = sandboxProfile({ tmp: os.tmpdir(), deny: magicDenyPaths() });
    const real = realPathOf(cmdHome);
    for (const f of ["secrets.json", "remote", "settings.json", "cmd.sqlite", "data", "logs"]) expect(profile).toContain(`(subpath "${path.join(real, f)}")`);
    expect(profile).toContain(`(subpath "${realPathOf(path.join(os.homedir(), ".config", "cmd"))}")`);
    expect(profile).not.toContain(`(subpath "${real}")`);
    expect(profile).not.toContain(`(subpath "${path.join(real, "widgets")}`);
    expect(profile).toMatch(/\(deny file-read\* \(regex #"\/\\\.cmd-dev\/\(secrets\\\.json\|/);
  });

  it.skipIf(!fs.existsSync("/usr/bin/sandbox-exec"))("the profile compiles", () => {
    // Even where it can't be applied (inside another sandbox), sandbox-exec parses it first: 65 is a syntax error.
    const r = spawnSync("/usr/bin/sandbox-exec", ["-p", sandboxProfile({ tmp: os.tmpdir(), deny: magicDenyPaths() }), "/usr/bin/true"], { encoding: "utf8" });
    if (r.status !== 0) expect(r.stderr).toMatch(/sandbox_apply/);
  });

  it("a sandboxed process can't read secrets.json but can read a widget", async ({ skip }) => {
    if (!sandboxAvailable()) {
      const reason = "sandbox-exec can't apply a profile here (e.g. inside another sandbox); the profile text is checked above";
      process.stderr.write(`[skip] ${reason}\n`);
      return skip(reason);
    }
    const deny = magicDenyPaths();
    const secret = await execCommand(`cat "${path.join(cmdHome, "secrets.json")}"`, { sandbox: "required", deny });
    expect(secret.code).not.toBe(0);
    expect(secret.stdout).not.toContain("sk-ant-secret");
    const host = await execCommand(`cat "${path.join(cmdHome, "remote", "host.json")}"`, { sandbox: "required", deny });
    expect(host.code).not.toBe(0);
    const ok = await execCommand(`cat "${path.join(widget, "data.ts")}"`, { sandbox: "required", deny });
    expect(ok).toMatchObject({ code: 0, stdout: "export default () => 1;" });
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
