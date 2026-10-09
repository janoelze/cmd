import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DATA_FLAGS, HOOK_FORMAT } from "@cmd/protocol";
import { redact, redactDeep, redactEvent } from "../src/redact.ts";
import { INLINE_LINE, claudeLine } from "../src/data/sources/transcripts.ts";
import { ActivityView } from "../src/data/views/activity.ts";
import { DataService } from "../src/data/service.ts";
import { ViewsStore } from "../src/data/views/views.ts";
import { DEFAULT_SETTINGS } from "@cmd/protocol";
import { JournalStore } from "../src/journal/store.ts";

// Values here are made up in the shape of real ones (checked against the author's transcripts, docs/25 3.8).
const gone = (text: string, ...secrets: string[]) => {
  const r = redact(text);
  for (const s of secrets) expect(r, text).not.toContain(s);
  expect(r).toContain("[redacted]");
  return r;
};

describe("redact", () => {
  it("knows the common token shapes", () => {
    gone("export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", "sk-ant-api03");
    gone("sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789", "oat01-abc");
    gone("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789", "sk-proj-abc");
    gone("token: ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abc");
    gone("github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz", "github_pat_11");
    gone("GITLAB=glpat-abcdefghijklmnopqrstu", "glpat-abc");
    gone("xoxb-1234567890-abcdefghij", "xoxb-1234");
    gone("AKIAABCDEFGHIJKLMNOP", "AKIAABCD");
    gone("key=AIzaSyA-abcdefghijklmnopqrstuvwxyz01234 ok", "AIzaSyA");
    gone("sk_live_abcdefghijklmnopqrstuvwxyz", "sk_live_abc");
    gone("npm_abcdefghijklmnopqrstuvwxyz0123456789", "npm_abc");
    gone("hf_abcdefghijklmnopqrstuvwxyz0123456789", "hf_abc");
    gone("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz", "eyJzdWI");
    gone("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----", "MIIEow");
    gone("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW", "b3BlbnNz");
  });

  it("takes passwords out of URLs and flags, keeping the rest", () => {
    expect(redact("git clone https://jan:hunter2secret@example.com/repo.git")).toBe("git clone https://jan:[redacted]@example.com/repo.git");
    expect(redact("curl https://api.example.com/v1/items?limit=5&token=abcdefghijklmnop")).toBe("curl https://api.example.com/v1/items?limit=5&token=[redacted]");
    gone("mysql -u root --password=hunter2secret db", "hunter2secret");
    gone("PGPASSWORD=hunter2secret psql", "hunter2secret");
  });

  it("takes headers out", () => {
    expect(redact('curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" https://x.y')).toBe('curl -H "Authorization: Bearer [redacted]" https://x.y');
    gone("Authorization: Basic amFuOmh1bnRlcjJzZWNyZXQ=", "amFuOmh1");
    expect(redact("Basic dXNlcjpwYXNzd29yZDEyMzQ=")).toBe("Basic [redacted]");
    expect(redact("Basic internationalization support")).toBe("Basic internationalization support");
    gone('"Cookie": "session=abcdefghijklmnopqrstuvwxyz; theme=dark"', "abcdefghijklmnopqrstuvwxyz");
  });

  it("takes values whose name says they're secrets", () => {
    gone('{"password": "correct-horse-battery"}', "correct-horse");
    gone("api_key=supersecretvalue123 ok", "supersecret");
    gone("export CMD_TOKEN='abcdefghijklmnop'", "abcdefghijklmnop");
    gone('DB_PASS="maXBnUKZq"', "maXBnUKZq");
    gone("PASS=correcthorse ./run", "correcthorse");
    gone('"password": "correcthorse"', "correcthorse");
    gone("TELEGRAM_TOKEN=\"${TELEGRAM_TOKEN:-6145070455:AAEabcdefghijklmnopqrstuvwxyz012345}\"", "AAEabcdef");
    gone("Set-Cookie: hss=abcdefghijklmnopqrstuvwxyz; expires=Mon; Secure", "abcdefghijklmnopqrstuvwxyz");
    expect(redact("api_key=supersecretvalue123 ok")).toContain("ok");
  });

  it("leaves code that names secrets alone", () => {
    for (const code of [
      "const key = process.env.API_KEY;\nAPI_KEY=$API_KEY ./run\ntoken: <your token>",
      "interface Auth { token: string; password: string }",
      "const token = await getToken(options);",
      "secret: ${{ secrets.NPM_TOKEN }}",
      "run 12345 succeeded on main",
      "git checkout -b fix-auth-token-refresh",
      "the auth token refresh happened twice",
      "Password must be at least 8 characters",
      "passwordField.focus()",
      "{ caseId: c.id, pass: problems.length === 0, warnings }",
      "credentials: credentialsFor(command) }",
      "loginToken = function (t) {",
      "$tokenC = AccessToken::verifyToken($aToken);",
      "echo secret\n: 1791080071:0;echo last",
      "author: Jan Oelze (https://example.com)",
      "needs five repo secrets: `MAC_CERT`, `APPLE_ID`",
      "tokenize = 'unicode61 remove_diacritics 2'",
      "maxOutputTokens: options.maxTokens ?? 4000",
      ".ui-secret:focus-within { --secret-edge: red }",
      "grep -q 'Authority=Developer ID Application'",
      "the single-pass generation of workflow-authoring: something",
      "Use --token only when automation cannot provide stdin",
      "--- PASS: TestRedaction (0.00s)",
      "headers: { AccessKey: password, 'Content-Type': contentType }",
      "npx tool --auth ~/some/credentials.json create",
    ])
      expect(redact(code)).toBe(code);
  });

  it("redacts every string in a payload, keeping its shape", () => {
    const v = redactDeep({ tool_input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'" }, n: 3, list: ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", 1] });
    expect(v.n).toBe(3);
    expect(v.list[1]).toBe(1);
    expect(JSON.stringify(v)).not.toMatch(/abcdefghij/);
  });
});

describe("redactDeep by key", () => {
  // The three shapes from docs/architecture-review-01 AR1-06-04.
  const shapes = { tool_input: { env: { API_TOKEN: "abcd1234efgh5678" }, password: "correcthorsebattery" }, headers: { Authorization: "Basic dXNlcjpwYXNzd29yZDEyMzQ=" } };

  it("takes a value whose key names a secret, in env maps and header maps too", () => {
    const v = redactDeep(shapes);
    expect(v.tool_input.env.API_TOKEN).toBe("[redacted]");
    expect(v.tool_input.password).toBe("[redacted]");
    expect(v.headers.Authorization).toBe("Basic [redacted]");
    expect(redactDeep({ authorization: "Bearer abcdefghijklmnop" }).authorization).toBe("Bearer [redacted]");
    expect(redactDeep({ "x-api-key": "abcdefghijklmnop", cookie: ["session=abcdefghijklmnop"], CMD_TOKEN: "abcdefghijklmnop", DB_PASS: "maXBnUKZq" })).toEqual({ "x-api-key": "[redacted]", cookie: ["[redacted]"], CMD_TOKEN: "[redacted]", DB_PASS: "[redacted]" });
    expect(redactDeep({ secrets: ["abcdefghijklmnop"], credential: ["abcdefghijklmnop"] }).credential).toEqual(["[redacted]"]);
  });

  it("leaves keys that only contain a secret word, and values that are code or short", () => {
    for (const v of [
      { author: "Jan Oelze", maxOutputTokens: 4096, tokenize: "words" },
      { usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0 }, authorName: "Jan Oelze", tokenizer: "cl100k_base_v2", passwordPolicy: "at least 8 characters" },
      { API_TOKEN: "$API_TOKEN", password: "process.env.DB_PASSWORD", token: "<your token>", secret: "${{ secrets.NPM_TOKEN }}", apiKey: "string", pwd: "short" },
      { properties: { password: { type: "string", description: "The password to log in with" } }, required: ["password", "token"] },
      { pass: "all tests passed", passed: true, token: null, secret: 12345678 },
      { env: { CLAUDE_CONFIG_DIR: "/Users/me/.claude-profiles/work", PATH: "/usr/bin:/bin" } },
    ])
      expect(redactDeep(v)).toEqual(v);
  });

  it("sets the event's redacted flag", () => {
    const data = new DataService({ file: null, recordedBy: "test", settings: () => DEFAULT_SETTINGS });
    const ev = data.record({ id: "h1", at: 1, type: "agent.hook", source: "hook:claude", data: { payload: shapes } })!;
    expect(ev.flags & DATA_FLAGS.redacted).toBe(DATA_FLAGS.redacted);
    expect(JSON.stringify(ev.data)).not.toMatch(/abcd1234|correcthorse|dXNlcjpw/);
    const clean = data.record({ id: "h2", at: 2, type: "agent.hook", source: "hook:claude", data: { payload: { author: "Jan Oelze", maxOutputTokens: 4096, tokenize: "words" } } })!;
    expect(clean.flags & DATA_FLAGS.redacted).toBe(0);
  });

  it("keeps the same secret out of a short transcript line and of one padded past the inline limit", () => {
    const line = (pad: string) => JSON.stringify({ type: "assistant", uuid: `u${pad.length}`, sessionId: "s", timestamp: "2026-10-06T10:00:00Z", cwd: "/w", message: { role: "assistant", id: "m1", content: [{ type: "text", text: `Calling the API.${pad}` }, { type: "tool_use", id: "t1", name: "mcp__api__call", input: shapes }] } });
    const file = { agent: "claude" as const, path: "/x/s.jsonl", env: null };
    const small = redactEvent(claudeLine(line(""), 1, file)!);
    const big = redactEvent(claudeLine(line(" padding".repeat(INLINE_LINE / 8 + 1)), 2, file)!);
    expect(small.content).toBeNull();
    expect(big.content!.length).toBeGreaterThan(INLINE_LINE);
    type Msg = { message: { content: { input?: typeof shapes }[] } };
    const inputOf = (m: Msg["message"]) => m.content[1]!.input!;
    const kept = [inputOf((small.data as Msg).message), inputOf((JSON.parse(big.content as string) as Msg).message)];
    for (const input of kept) expect([input.tool_input.env.API_TOKEN, input.tool_input.password, input.headers.Authorization]).toEqual(["[redacted]", "[redacted]", "Basic [redacted]"]);
    expect(JSON.stringify([small, big])).not.toMatch(/abcd1234|correcthorse|dXNlcjpw/);
  });
});

describe("redaction at the stores", () => {
  it("the activity log never keeps a credential", () => {
    const log = new ActivityView(new DataService({ file: null, recordedBy: "test", settings: () => DEFAULT_SETTINGS }), new ViewsStore(null));
    const ev = log.insert({ at: 1, agent: "claude", name: "PreToolUse", payload: { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' https://x.y" } }, hook: HOOK_FORMAT }, "p", "a");
    expect(ev.tool?.command).toContain("[redacted]");
    expect(JSON.stringify(log.events({ agentId: "a", raw: true }))).not.toContain("abcdefghij");
  });

  it("the activity log never keeps a secret held under a key (a recorded hook payload)", () => {
    const fixture = readFileSync(path.join(import.meta.dirname, "fixtures/agents/claude-2.1.289/edit-and-bash.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { name?: string; payload?: Record<string, unknown> });
    const pre = fixture.find((r) => r.name === "PreToolUse" && r.payload?.tool_name === "Bash")!;
    const tool_input = { ...(pre.payload!.tool_input as object), env: { API_TOKEN: "abcd1234efgh5678" }, password: "correcthorsebattery", headers: { Authorization: "Basic dXNlcjpwYXNzd29yZDEyMzQ=" } };
    const data = new DataService({ file: null, recordedBy: "test", settings: () => DEFAULT_SETTINGS });
    const log = new ActivityView(data, new ViewsStore(null));
    log.insert({ at: 1, agent: "claude", name: "PreToolUse", payload: { ...pre.payload!, tool_input }, hook: HOOK_FORMAT }, "p", "a");
    const [stored] = data.store.query({ types: ["agent.hook"] });
    expect(stored!.flags & DATA_FLAGS.redacted).toBe(DATA_FLAGS.redacted);
    const input = (stored!.data as { payload: { tool_input: typeof tool_input } }).payload.tool_input;
    expect(input).toMatchObject({ command: "echo 'fixed add' >> /work/repo/NOTES.md", env: { API_TOKEN: "[redacted]" }, password: "[redacted]", headers: { Authorization: "Basic [redacted]" } });
    expect(JSON.stringify(log.events({ agentId: "a", raw: true }))).not.toMatch(/abcd1234|correcthorse|dXNlcjpw/);
  });

  it("the journal never keeps a credential", () => {
    const s = new JournalStore();
    const id = s.record({ at: 1, until: 2, kind: "command", key: "c1", workspaceId: null, repo: null, cwd: null, thread: null, text: "export TOKEN=abcdefghijklmnop", data: { kind: "command", command: "export TOKEN=abcdefghijklmnop && deploy", exitCode: 0, paneId: null } });
    const [e] = s.events({});
    expect(e!.id).toBe(id);
    expect(JSON.stringify(e)).not.toContain("abcdefghijklmnop");
    expect((e!.data as { command: string }).command).toContain("deploy");
  });
});
