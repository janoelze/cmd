// Magic windows' providers: API keys kept out of settings (secrets.ts), the
// model lists (magic/models.ts), choosing a backend, and the old settings.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSettings } from "@cmd/protocol";
import { SecretsService, readSecrets } from "../src/secrets.ts";
import { backendFor, isOpenAIChatModel, listModels } from "../src/magic/index.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cmd-secrets-"));

describe("secrets", () => {
  it("stores keys in their own file, readable only by the user, and shows only a hint", () => {
    const file = path.join(tmp(), "secrets.json");
    const s = new SecretsService(file);
    const events: unknown[] = [];
    s.on("updated", (st) => events.push(st));
    const st = s.set("magic.anthropic.apiKey", "  sk-ant-abcdefgh1234  ");
    expect(st["magic.anthropic.apiKey"]).toEqual({ set: true, hint: "…1234" });
    expect(st["magic.openai.apiKey"]).toEqual({ set: false });
    expect(JSON.stringify(st)).not.toContain("abcdefgh");
    expect(s.get("magic.anthropic.apiKey")).toBe("sk-ant-abcdefgh1234");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(readSecrets(file)).toEqual({ "magic.anthropic.apiKey": "sk-ant-abcdefgh1234" });
    expect(new SecretsService(file).get("magic.anthropic.apiKey")).toBe("sk-ant-abcdefgh1234");
    expect(events).toHaveLength(1);
  });

  it("removes keys and refuses unknown ones", () => {
    const s = new SecretsService(null);
    s.set("magic.openai.apiKey", "sk-proj-0123456789");
    expect(s.set("magic.openai.apiKey", null)["magic.openai.apiKey"].set).toBe(false);
    expect(s.get("magic.openai.apiKey")).toBeUndefined();
    expect(() => s.set("magic.other", "x")).toThrow(/unknown secret/);
  });

  it("are served by the core without ever being sent", async () => {
    const { Core } = await import("../src/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const core = new Core({ socketPath: "", dbPath: null, terminals: fakeFactory().factory, pollMs: 0 });
    core.handlers["secrets.set"]({ key: "magic.anthropic.apiKey", value: "sk-ant-secretsecret" });
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
    await expect(listModels("anthropic", "bad", { fetch })).rejects.toThrow(/not accepted/);
  });

  it("are listed by the core with the stored key, and need one", async () => {
    const { Core } = await import("../src/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const core = new Core({ socketPath: "", dbPath: null, terminals: fakeFactory().factory, pollMs: 0 });
    await expect(core.handlers["magic.models"]({ provider: "openai" })).rejects.toThrow(/No OpenAI API key/);
    await expect(core.handlers["magic.models"]({ provider: "gemini" })).rejects.toThrow(/unknown provider/);
    await core.close();
  });
});

describe("choosing a backend", () => {
  it("uses the chosen provider and model, and needs the provider's key", () => {
    expect(backendFor({ provider: "openai", model: "gpt-5.5", apiKey: "sk-x" })).toMatchObject({ name: "openai", model: "gpt-5.5" });
    expect(backendFor({ provider: "anthropic", model: " claude-opus-5-5 ", apiKey: "sk-ant-x" })).toMatchObject({ name: "anthropic", model: "claude-opus-5-5" });
    expect(() => backendFor({ provider: "anthropic", model: "claude-opus-5-5", apiKey: undefined })).toThrow(/No Anthropic API key/);
    expect(() => backendFor({ provider: "openai", model: "", apiKey: "sk-x" })).toThrow(/No OpenAI model/);
    expect(() => backendFor({ provider: "claude-cli", model: "x", apiKey: "k" })).toThrow(/Unknown provider/);
  });

  it("a Magic window without a key says where to add one", async () => {
    const { Core } = await import("../src/core.ts");
    const { fakeFactory } = await import("./fake-pty.ts");
    const core = new Core({ socketPath: "", dbPath: null, terminals: fakeFactory().factory, pollMs: 0 });
    const w = core.handlers["window.open"]({ kind: "magic", input: {} }) as unknown as { id: string };
    core.handlers["magic.run"]({ id: w.id, prompt: "a pomodoro timer" });
    const state = core.windows.others().find((x) => x.id === w.id)!.state as { phase: string; error?: string };
    expect(state.phase).toBe("error");
    expect(state.error).toMatch(/No Anthropic API key: add one in Settings → Magic Windows/);
    await core.close();
  });

  it("carries an old magic.model over and ignores magic.baseUrl", () => {
    const r = resolveSettings({ "magic.model": "claude-haiku-4-5", "magic.baseUrl": "http://localhost:11434/v1" });
    expect(r.errors).toEqual([]);
    expect(r.settings["magic.anthropic.model"]).toBe("claude-haiku-4-5");
  });
});

describe("the window's workspace", () => {
  it("is named in the request, with what kind of folder it is", async () => {
    const { buildRequest } = await import("../src/magic/prompt.ts");
    const root = tmp();
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    const text = buildRequest("open pull requests", { cwd: root, workspace: { name: "shop", root }, explore: true });
    expect(text).toContain(`Workspace: this window belongs to the Space "shop" at ${root} (a git repository with package.json).`);
    expect(text).toMatch(/"this project", "the repo".*mean this folder/);
    expect(buildRequest("a timer", { cwd: root, workspace: null, explore: true })).not.toContain("Workspace:");
  });

  it("is the window's Space, not Home", async () => {
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
    const sp = (await core.call("space.open", { path: proj })).space;
    const inSpace = core.handlers["window.open"]({ kind: "magic", input: {}, spaceId: sp.id }) as unknown as { id: string };
    const inHome = core.handlers["window.open"]({ kind: "magic", input: {} }) as unknown as { id: string };
    core.handlers["magic.run"]({ id: inSpace.id, prompt: "what changed today" });
    core.handlers["magic.run"]({ id: inHome.id, prompt: "what changed today" });
    const end = Date.now() + 3000;
    while (seen.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    // The path may be shortened to ~ (Windows keeps temp folders in the home folder).
    expect(seen.find((t) => t.includes("Workspace:"))).toMatch(/the Space "shop" at \S*shop \(/);
    // Each window's request (its repair turns resend it): only the Space's names a workspace.
    expect(new Set(seen.filter((t) => t.includes("Workspace:"))).size).toBe(1);
    expect(seen.some((t) => !t.includes("Workspace:"))).toBe(true);
    await core.close();
  });
});
