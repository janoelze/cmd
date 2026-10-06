import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { HOOK_FORMAT } from "@cmd/protocol";
import { redact, redactDeep } from "../src/redact.ts";
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

describe("redaction at the stores", () => {
  it("the activity log never keeps a credential", () => {
    const log = new ActivityView(new DataService({ file: null, recordedBy: "test", settings: () => DEFAULT_SETTINGS }), new ViewsStore(null));
    const ev = log.insert({ at: 1, agent: "claude", name: "PreToolUse", payload: { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: { command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' https://x.y" } }, hook: HOOK_FORMAT }, "p", "a");
    expect(ev.tool?.command).toContain("[redacted]");
    expect(JSON.stringify(log.events({ agentId: "a", raw: true }))).not.toContain("abcdefghij");
  });

  it("the journal never keeps a credential", () => {
    const s = new JournalStore();
    const id = s.record({ at: 1, until: 2, kind: "command", key: "c1", spaceId: null, repo: null, cwd: null, thread: null, text: "export TOKEN=abcdefghijklmnop", data: { kind: "command", command: "export TOKEN=abcdefghijklmnop && deploy", exitCode: 0, paneId: null } });
    const [e] = s.events({});
    expect(e!.id).toBe(id);
    expect(JSON.stringify(e)).not.toContain("abcdefghijklmnop");
    expect((e!.data as { command: string }).command).toContain("deploy");
  });
});
