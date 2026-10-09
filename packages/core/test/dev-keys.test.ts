// API keys for development builds (dev-keys.ts): read from the environment or a
// checkout's .env, used only where Settings has none.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkouts, devKeys, parseEnv } from "../src/dev-keys.ts";
import { SecretsService } from "../src/secrets.ts";

let dir: string;
beforeEach(() => void (dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-devkeys-"))));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("dev keys", () => {
  it("parses .env lines", () => {
    expect(parseEnv('# keys\nexport OPENAI_API_KEY="sk-a"\nANTHROPIC_API_KEY = sk-b \nnot a line\nEMPTY=')).toEqual({ OPENAI_API_KEY: "sk-a", ANTHROPIC_API_KEY: "sk-b", EMPTY: "" });
  });

  it("finds the main checkout from a worktree, and the checkout a packaged build came from", () => {
    const main = path.join(dir, "cmd"), wt = path.join(dir, "cmd-topic"), runtime = path.join(dir, "runtime");
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${main}/.git/worktrees/cmd-topic\n`);
    expect(checkouts(wt)).toEqual([wt, main]);
    fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(runtime, ".checkout"), `${wt}\n`);
    expect(checkouts(runtime)).toEqual([wt, main]);
  });

  it("prefers the environment, then the nearest .env, and can be turned off", () => {
    fs.writeFileSync(path.join(dir, ".env"), "OPENAI_API_KEY=sk-from-file-1234\nANTHROPIC_API_KEY=sk-ant-file-5678\n");
    const k = devKeys(dir, { ANTHROPIC_API_KEY: "sk-ant-env-0000" });
    expect(k.values).toEqual({ "ai.openai.apiKey": "sk-from-file-1234", "ai.anthropic.apiKey": "sk-ant-env-0000" });
    expect(k.from).toEqual({ "ai.openai.apiKey": path.join(dir, ".env"), "ai.anthropic.apiKey": "environment" });
    expect(devKeys(dir, { CMD_DEV_KEYS: "off" }).values).toEqual({});
  });

  it("are used only where Settings has no key", () => {
    const s = new SecretsService(null, { values: { "ai.openai.apiKey": "sk-from-file-1234" }, from: { "ai.openai.apiKey": "/x/.env" } });
    expect(s.get("ai.openai.apiKey")).toBe("sk-from-file-1234");
    expect(s.status()["ai.openai.apiKey"]).toEqual({ set: true, hint: "…1234 from .env" });
    s.set("ai.openai.apiKey", "sk-typed-in-9999");
    expect(s.get("ai.openai.apiKey")).toBe("sk-typed-in-9999");
    expect(s.status()["ai.openai.apiKey"]).toEqual({ set: true, hint: "…9999" });
    s.set("ai.openai.apiKey", null);
    expect(s.get("ai.openai.apiKey")).toBe("sk-from-file-1234");
  });
});
