import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AnswerStream,
  classify,
  credentialsFor,
  redact,
  sandboxProfile,
  execCommand,
  fastRoute,
  parseAnswer,
  runMagic,
  runTool,
  sandboxAvailable,
  widgetHtml,
  type Backend,
} from "../src/magic/index.ts";
import { lintBody } from "../src/magic/lint.ts";
import { requestedMedia, widgetCsp } from "@cmd/protocol";
import type { BackendRun } from "../src/magic/backends.ts";

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

describe("answer contract", () => {
  const header = '{"kind":"widget","title":"VPN","source":{"type":"command","command":"scutil --nc list"},"refresh":10,"size":"s"}';

  it("parses header and body, tolerating preamble and fences", () => {
    for (const text of [`${header}\n---\n<div>x</div>`, `Sure!\n${header}\n---\n<div>x</div>`, "```\n" + `${header}\n---\n<div>x</div>\n` + "```", `${header}\n---\n\`\`\`html\n<div>x</div>\n\`\`\``]) {
      const r = parseAnswer(text);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.header.title).toBe("VPN");
        expect(r.header.source).toEqual({ type: "command", command: "scutil --nc list" });
        expect(r.body).toBe("<div>x</div>");
      }
    }
  });

  it("rejects missing headers, bodies and commands", () => {
    expect(parseAnswer("<div>no header</div>").ok).toBe(false);
    expect(parseAnswer('{"kind":"widget","title":"x"}\n---\n').ok).toBe(false);
    expect(parseAnswer('{"kind":"terminal","title":"x"}').ok).toBe(false);
    expect(parseAnswer('{"kind":"widget","title":"x","source":{"type":"fetch","url":"ftp://x"}}\n---\n<p>').ok).toBe(false);
  });

  it("parses media origins and rejects anything but https", () => {
    const r = parseAnswer('{"kind":"widget","title":"Radio","media":["https://a.example/stream.aacp","https://a.example","https://b.example:8443"]}\n---\n<audio>');
    expect(r.ok && r.header.media).toEqual(["https://a.example", "https://b.example:8443"]);
    expect(parseAnswer('{"kind":"widget","title":"Radio","media":["http://a.example"]}\n---\n<audio>').ok).toBe(false);
    expect(parseAnswer('{"kind":"widget","title":"Radio","media":"https://a.example"}\n---\n<audio>').ok).toBe(false);
  });

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

  it("streams the header as soon as its line is complete", () => {
    const s = new AnswerStream();
    expect(s.push(header.slice(0, 20)).header).toBeUndefined();
    const p = s.push(header.slice(20) + "\n---\n<div>");
    expect(p.header?.title).toBe("VPN");
    expect(p.body).toBe("<div>");
    expect(s.push("x</div>").body).toBe("<div>x</div>");
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
  const ctx = (cwd: string) => ({ cwd, home: cwd, deny: ["~/secret"], sandbox: "off" as const, tested: new Map() });

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

  it.skipIf(!posix)("tests command sources and remembers them", async () => {
    const c = ctx(os.tmpdir());
    const r = await runTool("test_source", { why: "", source: { type: "command", command: "echo '{\"up\": true}'" } }, c);
    expect(r.isError).toBe(false);
    expect(r.output).toContain('"up": true');
    expect(c.tested.size).toBe(1);
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

/** A backend that plays a script: tool calls, then a final answer, per turn. */
function scripted(turns: { calls?: { name: string; input: Record<string, unknown> }[]; answer: string }[]): Backend & { seen: BackendRun[] } {
  const seen: BackendRun[] = [];
  let i = 0;
  return {
    name: "fake",
    model: "fake-1",
    seen,
    async run(r) {
      seen.push(r);
      const t = turns[i++]!;
      for (const c of t.calls ?? []) {
        r.onTurn();
        await r.exec(c.name, c.input);
      }
      r.onTurn();
      for (const ch of t.answer.match(/[\s\S]{1,7}/g) ?? []) r.onText(ch);
      return { text: t.answer, model: "fake-1", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } };
    },
  };
}

describe("runMagic", () => {
  const src = { type: "command", command: "echo '{\"n\": 3}'" };
  const answer = `{"kind":"widget","title":"Count","source":${JSON.stringify(src)},"refresh":5,"size":"s"}\n---\n<div id=n></div><script>cmd.onData(d=>n.textContent=d.n)</script>`;

  it.skipIf(!posix)("runs tools, streams the header, and returns the tested sample", async () => {
    const backend = scripted([{ calls: [{ name: "test_source", input: { why: "Counting", source: src } }], answer }]);
    const events: string[] = [];
    const r = await runMagic({ prompt: "count things", backend, sandbox: "off", noFast: true, onEvent: (e) => events.push(e.type) });
    expect(r.ok).toBe(true);
    expect(r.repairs).toEqual([]);
    expect(r.header?.title).toBe("Count");
    expect(r.sample?.data).toEqual({ n: 3 });
    expect(r.trace.map((s) => [s.tool, s.why])).toEqual([["test_source", "Counting"]]);
    expect(events).toContain("header");
    expect(events.indexOf("step-start")).toBeLessThan(events.indexOf("header"));
    expect(backend.seen[0]!.system).toContain("# Examples");
    expect(backend.seen[0]!.messages[0]!.content).toMatch(/^Request: count things/);
  });

  it.skipIf(!posix)("shows the agent untested source data once, then accepts the same answer", async () => {
    const backend = scripted([{ answer }, { answer }]);
    const r = await runMagic({ prompt: "count things", backend, sandbox: "off", noFast: true });
    expect(r.repairs).toHaveLength(1);
    expect(r.repairs[0]).toMatch(/didn't test the source/);
    expect(r.ok).toBe(true);
    expect(backend.seen[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("asks for a repair when the answer is malformed", async () => {
    const backend = scripted([{ answer: "Here is your widget!" }, { answer: '{"kind":"terminal","title":"Top","command":"top -o cpu"}' }]);
    const r = await runMagic({ prompt: "cpu", backend, sandbox: "off", noFast: true });
    expect(r.repairs[0]).toMatch(/format/);
    expect(r.ok).toBe(true);
    expect(r.header?.command).toBe("top -o cpu");
  });

  it("drops exploring tools when exploring is off", async () => {
    const backend = scripted([{ answer: '{"kind":"terminal","title":"x","command":"ls"}' }]);
    await runMagic({ prompt: "x", backend, explore: false, noFast: true });
    expect(backend.seen[0]!.tools.map((t) => t.name)).toEqual(["fetch", "test_source"]);
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

describe("Magic windows in the core", () => {
  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it.skipIf(!posix)("runs a request into the window's state, streams progress, and refreshes the source", async () => {
    const { Core } = await import("../src/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const src = { type: "command", command: "echo '{\"n\": 7}'" };
    const answer = `{"kind":"widget","title":"Seven","source":${JSON.stringify(src)},"refresh":2,"size":"s"}\n---\n<div id=n></div><script>cmd.onData(d=>n.textContent=d.n)</script>`;
    const backend = scripted([{ calls: [{ name: "test_source", input: { why: "Counting", source: src } }], answer }]);
    process.env.CMD_MAGIC_UNSANDBOXED = "1";
    const core = new Core({ socketPath: "", dbPath: null, terminals: fakeFactory().factory, pollMs: 0, magicBackend: () => backend });
    const w = core.handlers["window.open"]({ kind: "magic", input: {} }) as unknown as { id: string; state: { phase: string } };
    expect(w.state.phase).toBe("empty");
    core.handlers["magic.run"]({ id: w.id, prompt: "count to seven" });
    const state = () => core.windows.others().find((x) => x.id === w.id)!.state as Record<string, unknown>;
    expect(state().phase).toBe("working");
    await until(() => state().phase === "ready");
    const s = state();
    expect(core.windows.others().find((x) => x.id === w.id)!.title).toBe("Seven");
    expect(s.kind).toBe("widget");
    expect(s.source).toEqual(src);
    expect(s.lastData).toMatchObject({ data: { n: 7 } });
    expect((s.steps as { why: string; ms?: number }[])[0]).toMatchObject({ why: "Counting" });
    expect(s.answer).toContain('"title":"Seven"');
    await core.close();
    delete process.env.CMD_MAGIC_UNSANDBOXED;
  });

  it("asks for a widget's media origins and remembers the answer", async () => {
    const { Core } = await import("../src/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const answer = '{"kind":"widget","title":"Radio","media":["https://a.example","https://b.example"]}\n---\n<audio id=au></audio>';
    const core = new Core({ socketPath: "", dbPath: null, terminals: fakeFactory().factory, pollMs: 0, magicBackend: () => scripted([{ calls: [], answer }]) });
    const w = core.handlers["window.open"]({ kind: "magic", input: {} }) as unknown as { id: string };
    const state = () => core.windows.others().find((x) => x.id === w.id)!.state as Record<string, unknown>;
    core.handlers["magic.run"]({ id: w.id, prompt: "a dnb radio" });
    await until(() => state().phase === "ready");
    expect(state().media).toEqual(["https://a.example", "https://b.example"]);
    core.handlers["magic.media"]({ id: w.id, allow: false });
    expect(state().mediaDenied).toEqual(["https://a.example", "https://b.example"]);
    core.handlers["magic.media"]({ id: w.id, allow: true });
    expect(state()).toMatchObject({ mediaAllowed: ["https://a.example", "https://b.example"], mediaDenied: [] });
    await core.close();
  });

  it("lets the person set the source's interval, and keeps it across refinements", async () => {
    const { Core } = await import("../src/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const answer = '{"kind":"widget","title":"Clock","source":{"type":"fetch","url":"https://example.com/t"},"refresh":10}\n---\n<div></div>';
    const core = new Core({ socketPath: "", dbPath: null, terminals: fakeFactory().factory, pollMs: 0, magicBackend: () => scripted([{ answer }, { answer }]) });
    const w = core.handlers["window.open"]({ kind: "magic", input: {} }) as unknown as { id: string };
    const state = () => core.windows.others().find((x) => x.id === w.id)!.state as Record<string, unknown>;
    core.handlers["magic.run"]({ id: w.id, prompt: "a clock" });
    await until(() => state().phase === "ready");
    expect(state().refresh).toBe(10);
    core.handlers["magic.setRefresh"]({ id: w.id, seconds: 300 });
    expect(state()).toMatchObject({ refresh: 300, refreshByUser: true });
    core.handlers["magic.setRefresh"]({ id: w.id, seconds: 0.5 });
    expect(state().refresh).toBe(2);
    expect(() => core.handlers["magic.setRefresh"]({ id: w.id, seconds: -1 })).toThrow();
    core.handlers["magic.setRefresh"]({ id: w.id, seconds: 60 });
    core.handlers["magic.run"]({ id: w.id, prompt: "bigger" });
    await until(() => state().phase === "ready");
    expect(state()).toMatchObject({ refresh: 60, refreshByUser: true });
    await core.close();
  });

  it("gives each refinement every earlier request, not only the first", async () => {
    const { Core } = await import("../src/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const answer = '{"kind":"widget","title":"Radio"}\n---\n<audio id=au></audio>';
    const backend = scripted([{ answer }, { answer }, { answer }]);
    const core = new Core({ socketPath: "", dbPath: null, terminals: fakeFactory().factory, pollMs: 0, magicBackend: () => backend });
    const w = core.handlers["window.open"]({ kind: "magic", input: {} }) as unknown as { id: string };
    const state = () => core.windows.others().find((x) => x.id === w.id)!.state as Record<string, unknown>;
    const asks = ["a dnb radio from somafm, autoplay muted", "add a volume slider", "make it dark"];
    for (const [i, prompt] of asks.entries()) {
      core.handlers["magic.run"]({ id: w.id, prompt });
      await until(() => backend.seen.length === i + 1 && state().phase === "ready");
    }
    const last = backend.seen[2]!.messages[0]!.content;
    expect(last).toContain("1. a dnb radio from somafm, autoplay muted");
    expect(last).toContain("2. add a volume slider");
    expect(last).toContain("make it dark");
    expect(last).toContain("<audio id=au></audio>");
    expect(state()).toMatchObject({ prompt: "a dnb radio from somafm, autoplay muted", history: asks });
    await core.close();
  });

  it("keeps a working widget when a refinement fails, and reports empty requests", async () => {
    const { Core } = await import("../src/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    let turn = 0;
    const answers = ['{"kind":"terminal","title":"Top","command":"top -o cpu"}', "nonsense", "still nonsense"];
    const backend: Backend = {
      name: "fake",
      model: "fake-1",
      async run(r) {
        const text = answers[turn++]!;
        r.onTurn();
        r.onText(text);
        return { text, model: "fake-1", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
      },
    };
    const core = new Core({ socketPath: "", dbPath: null, terminals: fakeFactory().factory, pollMs: 0, magicBackend: () => backend });
    const w = core.handlers["window.open"]({ kind: "magic", input: {} }) as unknown as { id: string };
    const state = () => core.windows.others().find((x) => x.id === w.id)!.state as Record<string, unknown>;
    expect(() => core.handlers["magic.run"]({ id: w.id, prompt: "  " })).toThrow(/empty/);
    core.handlers["magic.run"]({ id: w.id, prompt: "what is using my cpu" });
    await until(() => state().phase === "ready");
    expect(state()).toMatchObject({ kind: "terminal", command: "top -o cpu" });
    core.handlers["magic.run"]({ id: w.id, prompt: "make it a widget" });
    await until(() => state().phase !== "working");
    expect(state()).toMatchObject({ phase: "ready", kind: "terminal", command: "top -o cpu" });
    expect(String(state().error)).toMatch(/format/);
    expect(state().history).toEqual(["what is using my cpu", "make it a widget"]);
    await core.close();
  });
});
