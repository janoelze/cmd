// AI providers (docs/17-ai.md): API keys kept out of settings (secrets.ts), the
// model lists (ai/models.ts), the AiService (keys, tiers, calls), and the old
// Magic settings and secrets.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSettings } from "@cmd/protocol";
import { SecretsService, readSecrets } from "../src/secrets.ts";
import { AiService, isOpenAIChatModel, KeyRejected, listModels, pickModel } from "../src/magic/index.ts";
import type { AiModel, Settings } from "@cmd/protocol";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmd-secrets-"));

describe("secrets", () => {
  it("stores keys in their own file, readable only by the user, and shows only a hint", () => {
    const file = path.join(tmp(), "secrets.json");
    const s = new SecretsService(file);
    const events: unknown[] = [];
    s.on("updated", (st) => events.push(st));
    const st = s.set("ai.anthropic.apiKey", "  sk-ant-abcdefgh1234  ");
    expect(st["ai.anthropic.apiKey"]).toEqual({ set: true, hint: "…1234" });
    expect(st["ai.openai.apiKey"]).toEqual({ set: false });
    expect(JSON.stringify(st)).not.toContain("abcdefgh");
    expect(s.get("ai.anthropic.apiKey")).toBe("sk-ant-abcdefgh1234");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readSecrets(file)).toEqual({ "ai.anthropic.apiKey": "sk-ant-abcdefgh1234" });
    expect(new SecretsService(file).get("ai.anthropic.apiKey")).toBe("sk-ant-abcdefgh1234");
    expect(events).toHaveLength(1);
  });

  it("removes keys and refuses unknown ones", () => {
    const s = new SecretsService(null);
    s.set("ai.openai.apiKey", "sk-proj-0123456789");
    expect(s.set("ai.openai.apiKey", null)["ai.openai.apiKey"].set).toBe(false);
    expect(s.get("ai.openai.apiKey")).toBeUndefined();
    expect(() => s.set("magic.other", "x")).toThrow(/unknown secret/);
  });

  it("move from their old Magic names, in the file too", () => {
    const file = path.join(tmp(), "secrets.json");
    fs.writeFileSync(file, JSON.stringify({ "magic.anthropic.apiKey": "sk-ant-old", "magic.openai.apiKey": "sk-old", "ai.openai.apiKey": "sk-new" }));
    const s = new SecretsService(file);
    expect(s.get("ai.anthropic.apiKey")).toBe("sk-ant-old");
    expect(s.get("ai.openai.apiKey")).toBe("sk-new"); // the new name wins
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ "ai.anthropic.apiKey": "sk-ant-old", "ai.openai.apiKey": "sk-new" });
    expect(s.set("magic.anthropic.apiKey", "sk-ant-via-old-name")["ai.anthropic.apiKey"].set).toBe(true);
    expect(s.get("ai.anthropic.apiKey")).toBe("sk-ant-via-old-name");
  });

  it("are served by the core without ever being sent", async () => {
    const { Core } = await import("../src/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const core = new Core({ socketPath: "", dbPath: null, terminals: fakeFactory().factory, pollMs: 0 });
    core.handlers["secrets.set"]({ key: "ai.anthropic.apiKey", value: "sk-ant-secretsecret" });
    const status = core.handlers["secrets.status"]({}) as unknown;
    expect(JSON.stringify(status)).not.toContain("secretsecret");
    expect(JSON.stringify(core.settings.snapshot())).not.toContain("secretsecret");
    await core.close();
  });
});

describe("model lists", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("lists Anthropic models across pages, with the key in the headers", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetch = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      return url.includes("after_id")
        ? json({ data: [{ id: "claude-old", display_name: "Claude Old", created_at: "2024-01-01T00:00:00Z" }], has_more: false })
        : json({ data: [{ id: "claude-new", display_name: "Claude New", created_at: "2026-07-01T00:00:00Z" }], has_more: true, last_id: "claude-new" });
    }) as unknown as typeof globalThis.fetch;
    const models = await listModels("anthropic", "sk-ant-x", { fetch });
    expect(models.map((m) => [m.id, m.name])).toEqual([
      ["claude-new", "Claude New"],
      ["claude-old", "Claude Old"],
    ]);
    expect(seen[0]!.headers).toMatchObject({ "x-api-key": "sk-ant-x", "anthropic-version": "2023-06-01" });
    expect(seen[1]!.url).toContain("after_id=claude-new");
  });

  it("keeps only OpenAI chat models, newest first", async () => {
    const fetch = (async () =>
      json({
        data: [
          { id: "gpt-4o", created: 100 },
          { id: "text-embedding-3-small", created: 300 },
          { id: "gpt-5.5", created: 200 },
          { id: "gpt-realtime-2.1", created: 400 },
          { id: "o3", created: 150 },
          { id: "dall-e-3", created: 50 },
        ],
      })) as unknown as typeof globalThis.fetch;
    expect((await listModels("openai", "sk-x", { fetch })).map((m) => m.id)).toEqual(["gpt-5.5", "o3", "gpt-4o"]);
    expect(isOpenAIChatModel("gpt-4o-mini-transcribe")).toBe(false);
    expect(isOpenAIChatModel("chatgpt-4o-latest")).toBe(true);
    expect(["gpt-5.5-2026-04-23", "gpt-3.5-turbo-0125", "gpt-4-turbo", "gpt-live-1"].filter(isOpenAIChatModel)).toEqual([]);
    expect(["gpt-4o", "gpt-4.1-mini", "gpt-5.3-chat-latest", "o3-pro"].every(isOpenAIChatModel)).toBe(true);
  });

  it("says so when the key is refused", async () => {
    const fetch = (async () => json({ error: { message: "invalid x-api-key" } }, 401)) as unknown as typeof globalThis.fetch;
    await expect(listModels("anthropic", "bad", { fetch })).rejects.toBeInstanceOf(KeyRejected);
  });

  it("are listed by the core with the stored key, and need one", async () => {
    const { Core } = await import("../src/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const core = new Core({ socketPath: "", dbPath: null, terminals: fakeFactory().factory, pollMs: 0 });
    await expect(core.handlers["ai.models"]({ provider: "openai" })).rejects.toThrow(/No OpenAI API key/);
    await expect(core.handlers["ai.models"]({ provider: "gemini" })).rejects.toThrow(/unknown provider/);
    await core.close();
  });
});

const ANTHROPIC: AiModel[] = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", created: 500 },
  { id: "claude-opus-5-6", name: "Claude Opus 5.6", created: 400 },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", created: 300 },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", created: 200 },
];
const OPENAI: AiModel[] = [
  { id: "gpt-6-mini", name: "gpt-6-mini", created: 700 },
  { id: "gpt-6-pro", name: "gpt-6-pro", created: 650 },
  { id: "gpt-6", name: "gpt-6", created: 600 },
  { id: "gpt-5.5", name: "gpt-5.5", created: 500 },
  { id: "gpt-5-mini", name: "gpt-5-mini", created: 100 },
];

describe("picking models", () => {
  it("takes the newest model of the tier's family", () => {
    expect(pickModel("anthropic", "smart", ANTHROPIC)?.id).toBe("claude-opus-5-6");
    expect(pickModel("anthropic", "fast", ANTHROPIC)?.id).toBe("claude-haiku-4-5-20251001");
    expect(pickModel("openai", "smart", OPENAI)?.id).toBe("gpt-6");
    expect(pickModel("openai", "fast", OPENAI)?.id).toBe("gpt-6-mini");
    expect(pickModel("anthropic", "smart", [{ id: "claude-sonnet-5-5", name: "" }])).toBeUndefined();
  });
});

/** An AiService over in-memory secrets, with fake model lists per key. */
function service(o: { settings?: Partial<Settings>; lists?: Record<string, AiModel[] | Error>; stateDir?: string | null; secrets?: SecretsService } = {}) {
  const secrets = o.secrets ?? new SecretsService(null);
  const settings = { ...resolveSettings({}).settings, ...o.settings } as Settings;
  const calls: string[] = [];
  const ai = new AiService({
    settings: () => settings,
    secrets,
    stateDir: o.stateDir ?? null,
    listModels: async (provider, key) => {
      calls.push(`${provider} ${key}`);
      const r = o.lists?.[key];
      if (r instanceof Error) throw r;
      if (r) return r;
      throw new KeyRejected("The key was not accepted.");
    },
  });
  return { ai, secrets, settings, calls };
}

describe("the AI service", () => {
  it("is not ready without a key, and says how to fix it", () => {
    const { ai } = service();
    expect(ai.status()).toMatchObject({ ready: false, provider: null, providers: { anthropic: { state: "none" }, openai: { state: "none" } } });
    expect(() => ai.backend({ tier: "smart", purpose: "test" })).toThrow(/Settings → AI/);
  });

  it("checks a key before storing it, and resolves tiers from what the key can use", async () => {
    const { ai, secrets } = service({ lists: { "sk-ant-good": ANTHROPIC } });
    const events: unknown[] = [];
    ai.on("updated", (s) => events.push(s));
    await expect(ai.connect("anthropic", "sk-ant-bad")).rejects.toThrow(/didn't accept this key/);
    expect(secrets.get("ai.anthropic.apiKey")).toBeUndefined();
    const st = await ai.connect("anthropic", " sk-ant-good ");
    expect(secrets.get("ai.anthropic.apiKey")).toBe("sk-ant-good");
    expect(st).toMatchObject({ ready: true, provider: "anthropic" });
    expect(st.providers.anthropic).toMatchObject({
      state: "ok",
      models: { smart: { id: "claude-opus-5-6", name: "Claude Opus 5.6", auto: true }, fast: { id: "claude-haiku-4-5-20251001", auto: true } },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(ai.backend({ tier: "smart", purpose: "test" })).toMatchObject({ name: "anthropic", model: "claude-opus-5-6" });
    expect(ai.backend({ tier: "fast", purpose: "test" }).model).toBe("claude-haiku-4-5-20251001");
    await ai.connect("anthropic", null);
    expect(ai.status().ready).toBe(false);
  });

  it("stores a key it can't check now, unchecked, and uses the fallback models", async () => {
    const { ai, secrets } = service({ lists: { "sk-offline": new Error("fetch failed") } });
    const st = await ai.connect("openai", "sk-offline");
    expect(secrets.get("ai.openai.apiKey")).toBe("sk-offline");
    expect(st.providers.openai).toMatchObject({ state: "unchecked", error: expect.stringMatching(/Couldn't reach OpenAI/) });
    expect(st.ready).toBe(true);
    expect(st.providers.openai.models?.smart).toEqual({ id: "gpt-5.5", name: "gpt-5.5", auto: true });
  });

  it("keeps a pinned model, and uses ai.provider only while its key works", async () => {
    const { ai } = service({ settings: { "ai.provider": "openai", "ai.anthropic.model": "claude-opus-5-5" }, lists: { "sk-ant": ANTHROPIC, "sk-oa": OPENAI } });
    await ai.connect("anthropic", "sk-ant");
    expect(ai.status().provider).toBe("anthropic"); // openai has no key
    expect(ai.model("anthropic", "smart")).toEqual({ id: "claude-opus-5-5", name: "Claude Opus 5.5", auto: false });
    await ai.connect("openai", "sk-oa");
    expect(ai.status().provider).toBe("openai");
    expect(ai.backend({ tier: "smart", purpose: "test" }).model).toBe("gpt-6");
    expect(ai.backend({ tier: "smart", purpose: "test", provider: "anthropic", model: "claude-x" })).toMatchObject({ name: "anthropic", model: "claude-x" });
  });

  it("notices a key the provider stops accepting, and falls back to another provider", async () => {
    const lists: Record<string, AiModel[] | Error> = { "sk-oa": OPENAI, "sk-ant": ANTHROPIC };
    const { ai } = service({ settings: { "ai.provider": "openai" }, lists });
    await ai.connect("openai", "sk-oa");
    await ai.connect("anthropic", "sk-ant");
    lists["sk-oa"] = new KeyRejected("The key was not accepted.");
    await expect(ai.models("openai", true)).rejects.toBeInstanceOf(KeyRejected);
    const st = ai.status();
    expect(st.providers.openai).toMatchObject({ state: "rejected", error: expect.stringMatching(/no longer accepts/) });
    expect(st.provider).toBe("anthropic");
  });

  it("remembers model lists across restarts, per key", async () => {
    const dir = tmp();
    const secrets = new SecretsService(path.join(dir, "secrets.json"));
    const first = service({ stateDir: dir, secrets, lists: { "sk-ant": ANTHROPIC } });
    await first.ai.connect("anthropic", "sk-ant");
    const again = service({ stateDir: dir, secrets: new SecretsService(path.join(dir, "secrets.json")) });
    expect(again.ai.status().providers.anthropic).toMatchObject({ state: "ok", models: { smart: { id: "claude-opus-5-6" } } });
    expect(again.calls).toEqual([]);
    // Another key: unchecked until the provider says otherwise.
    again.secrets.set("ai.anthropic.apiKey", "sk-ant-other");
    expect(again.ai.status().providers.anthropic.state).toBe("unchecked");
  });

  it("a Magic widget without a key says where to add one", async () => {
    const { Core } = await import("../src/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const core = new Core({ socketPath: "", dbPath: null, terminals: fakeFactory().factory, pollMs: 0 });
    const w = core.handlers["window.open"]({ kind: "magic", input: {} }) as unknown as { id: string };
    core.handlers["magic.run"]({ id: w.id, prompt: "a pomodoro timer" });
    const state = core.windows.others().find((x) => x.id === w.id)!.state as { phase: string; error?: string };
    expect(state.phase).toBe("error");
    expect(state.error).toMatch(/No AI provider is set up\. Add an API key in Settings → AI/);
    await core.close();
  });

  it("carries the old Magic settings over and ignores magic.baseUrl", () => {
    const r = resolveSettings({ "magic.model": "claude-haiku-4-5", "magic.baseUrl": "http://localhost:11434/v1", "magic.provider": "openai", "magic.openai.model": "gpt-5.5" });
    expect(r.errors).toEqual([]);
    expect(r.settings["ai.anthropic.model"]).toBe("claude-haiku-4-5");
    expect(r.settings["ai.provider"]).toBe("openai");
    expect(r.settings["ai.openai.model"]).toBe("gpt-5.5");
    expect(resolveSettings({}).settings["ai.openai.fastModel"]).toBe("auto");
  });
});

describe("the window's workspace", () => {
  it("is named in the request, with what kind of folder it is", async () => {
    const { buildRequest } = await import("../src/magic/prompt.ts");
    const root = tmp();
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    const text = buildRequest("open pull requests", { cwd: root, workspace: { name: "shop", root }, explore: true });
    expect(text).toContain(`Workspace: this window belongs to the workspace "shop" at ${root} (a git repository with package.json).`);
    expect(text).toMatch(/"this project", "the repo".*mean this folder/);
    expect(buildRequest("a timer", { cwd: root, workspace: null, explore: true })).not.toContain("Workspace:");
  });

  it("is the window's workspace, not Home", async () => {
    const { Core } = await import("../src/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const home = fs.realpathSync(tmp());
    const proj = path.join(home, "shop");
    fs.mkdirSync(proj);
    const seen: string[] = [];
    const answer = "Done.";
    const backend = {
      name: "fake",
      model: "fake-1",
      async run(r: { messages: { content: string }[]; onTurn: () => void; onText: (d: string) => void }) {
        seen.push(r.messages[0]!.content);
        r.onTurn();
        r.onText(answer);
        return { text: answer, model: "fake-1", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      },
    };
    const core = new Core({ socketPath: "", dbPath: null, terminals: fakeFactory().factory, pollMs: 0, home, magicBackend: () => backend as never });
    const sp = (await core.call("workspace.open", { path: proj })).workspace;
    const inWorkspace = core.handlers["window.open"]({ kind: "magic", input: {}, workspaceId: sp.id }) as unknown as { id: string };
    const inHome = core.handlers["window.open"]({ kind: "magic", input: {} }) as unknown as { id: string };
    core.handlers["magic.run"]({ id: inWorkspace.id, prompt: "what changed today" });
    core.handlers["magic.run"]({ id: inHome.id, prompt: "what changed today" });
    const end = Date.now() + 3000;
    while (seen.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    // The path may be shortened to ~ (Windows keeps temp folders in the home folder).
    expect(seen.find((t) => t.includes("Workspace:"))).toMatch(/the workspace "shop" at \S*shop \(/);
    // Each window's request (its repair turns resend it): only the workspace's names a workspace.
    expect(new Set(seen.filter((t) => t.includes("Workspace:"))).size).toBe(1);
    expect(seen.some((t) => !t.includes("Workspace:"))).toBe(true);
    await core.close();
  });
});
