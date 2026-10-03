// Model backends for the Magic agent. Each runs the tool loop to its final text
// answer; the tools themselves always execute in-process through `exec` (see
// tools.ts), so the policy, the sandbox and the budget are the same everywhere.
//
// - "ai": the Vercel AI SDK. One loop for every API provider: Anthropic, and any
//   OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, Cerebras, Ollama, LM Studio).
// - "claude-cli": the user's own `claude` login, for people without an API key.
//   Claude Code runs its own loop with its built-in tools off; it reaches ours
//   through an MCP server (`cmd magic mcp`) that relays each call back here.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { jsonSchema, stepCountIs, streamText, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ToolOutput, ToolSpec } from "./tools.ts";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUSD?: number;
}

export interface BackendRun {
  system: string;
  /** Plain-text turns; the last one is the user's. */
  messages: { role: "user" | "assistant"; content: string }[];
  tools: ToolSpec[];
  exec: (name: string, input: Record<string, unknown>) => Promise<ToolOutput>;
  /** Tool calls allowed before the model must answer. */
  maxSteps: number;
  signal?: AbortSignal;
  onText: (delta: string) => void;
  /** A new model turn starts: text so far was preamble, not the answer. */
  onTurn: () => void;
}

export interface BackendResult {
  text: string;
  usage: Usage;
  model: string;
}

export interface Backend {
  name: string;
  model: string;
  run(r: BackendRun): Promise<BackendResult>;
}

// ── AI SDK ───────────────────────────────────────────────

export interface AiBackendOptions {
  provider: "anthropic" | "openai-compatible";
  model: string;
  apiKey?: string;
  /** openai-compatible: the endpoint, e.g. http://localhost:11434/v1 (Ollama). */
  baseURL?: string;
  /** Anthropic models that take it: low | medium | high. */
  effort?: "low" | "medium" | "high";
}

export function aiBackend(o: AiBackendOptions): Backend {
  let model: LanguageModel;
  if (o.provider === "anthropic") {
    model = createAnthropic({ apiKey: o.apiKey })(o.model);
  } else {
    if (!o.baseURL) throw new Error("openai-compatible needs a base URL");
    model = createOpenAICompatible({ name: "magic", baseURL: o.baseURL, apiKey: o.apiKey })(o.model);
  }
  // Haiku 4.5 and older models reject `effort`.
  const takesEffort = o.provider === "anthropic" && !/haiku|claude-3|-4-5|-4-1|-4-0|sonnet-4-0/.test(o.model);
  return {
    name: o.provider,
    model: o.model,
    async run(r) {
      const tools: ToolSet = {};
      for (const spec of r.tools) {
        tools[spec.name] = tool({
          description: spec.description,
          inputSchema: jsonSchema(spec.schema as never),
          execute: async (input: unknown) => {
            const out = await r.exec(spec.name, (input ?? {}) as Record<string, unknown>);
            return out.isError ? `Error: ${out.output}` : out.output;
          },
        });
      }
      const messages: ModelMessage[] = r.messages.map((m) => ({ role: m.role, content: m.content }));
      const result = streamText({
        model,
        instructions: [{ role: "system", content: r.system, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } }],
        messages,
        tools,
        // maxSteps tool turns, plus the answer.
        stopWhen: stepCountIs(r.maxSteps + 1),
        prepareStep: ({ stepNumber }) => (stepNumber >= r.maxSteps ? { activeTools: [] } : {}),
        abortSignal: r.signal,
        maxOutputTokens: 16_000,
        providerOptions: takesEffort && o.effort ? { anthropic: { effort: o.effort } } : undefined,
      });
      let text = "";
      for await (const part of result.fullStream) {
        if (part.type === "start-step") {
          text = "";
          r.onTurn();
        } else if (part.type === "text-delta") {
          text += part.text;
          r.onText(part.text);
        } else if (part.type === "error") {
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
      }
      const u = await result.totalUsage;
      const details = (u as { inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } }).inputTokenDetails;
      return {
        text,
        model: o.model,
        usage: {
          input: u.inputTokens ?? 0,
          output: u.outputTokens ?? 0,
          cacheRead: details?.cacheReadTokens ?? (u as { cachedInputTokens?: number }).cachedInputTokens ?? 0,
          cacheWrite: details?.cacheWriteTokens ?? 0,
        },
      };
    },
  };
}

// ── claude CLI ───────────────────────────────────────────

export interface ClaudeCliOptions {
  model: string;
  /** The claude binary; default: `claude` on PATH, else ~/.local/bin/claude. */
  bin?: string;
  /** argv that starts the MCP relay server; default: this Node running mcp-main.ts. */
  mcpCommand?: string[];
}

const MCP_MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp-main.ts");

function findClaude(): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = path.join(dir, "claude");
    if (dir && fs.existsSync(p)) return p;
  }
  const local = path.join(os.homedir(), ".local/bin/claude");
  if (fs.existsSync(local)) return local;
  throw new Error("the claude CLI was not found");
}

export function claudeCliAvailable(): boolean {
  try {
    findClaude();
    return true;
  } catch {
    return false;
  }
}

/** Env var that tells `cmd magic mcp` where to relay tool calls, and which tools to offer. */
export const RELAY_ENV = "CMD_MAGIC_RELAY";
export const RELAY_TOOLS_ENV = "CMD_MAGIC_TOOLS";

type CliResult = { result?: string; usage?: Record<string, number>; total_cost_usd?: number; is_error?: boolean };

export function claudeCliBackend(o: ClaudeCliOptions): Backend {
  return {
    name: "claude-cli",
    model: o.model,
    async run(r) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-magic-cc-"));
      const sock = path.join(dir, "relay.sock");
      let calls = 0;
      // Relay: one JSON line per tool call from the MCP server, one reply line.
      const server = net.createServer((c) => {
        let buf = "";
        c.on("data", async (d) => {
          buf += d.toString("utf8");
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            const req = JSON.parse(line) as { id: number; name: string; input: Record<string, unknown> };
            let out: ToolOutput;
            if (++calls > r.maxSteps) out = { output: "Out of steps: answer now with what you have.", isError: true };
            else out = await r.exec(req.name, req.input ?? {}).catch((e: Error) => ({ output: e.message, isError: true }));
            c.write(JSON.stringify({ id: req.id, ...out }) + "\n");
          }
        });
      });
      await new Promise<void>((res) => server.listen(sock, res));
      const mcp = o.mcpCommand ?? [process.execPath, "--no-warnings", MCP_MAIN];
      const mcpConfig = {
        mcpServers: {
          magic: {
            command: mcp[0],
            args: mcp.slice(1),
            env: { [RELAY_ENV]: sock, [RELAY_TOOLS_ENV]: r.tools.map((t) => t.name).join(",") },
          },
        },
      };
      // claude -p is stateless here: earlier turns go into the prompt.
      const prompt =
        r.messages.length === 1
          ? r.messages[0]!.content
          : r.messages.map((m) => `${m.role === "user" ? "User" : "Your earlier answer"}:\n${m.content}`).join("\n\n---\n\n");
      const args = [
        "-p", prompt,
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--system-prompt", r.system,
        "--model", o.model,
        "--tools", "",
        "--mcp-config", JSON.stringify(mcpConfig),
        "--strict-mcp-config",
        "--allowedTools", r.tools.map((t) => `mcp__magic__${t.name}`).join(","),
        "--permission-mode", "dontAsk",
        "--setting-sources", "",
        "--no-session-persistence",
      ];
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY; // use the login
      const child = spawn(o.bin ?? findClaude(), args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      const onAbort = () => child.kill("SIGTERM");
      r.signal?.addEventListener("abort", onAbort, { once: true });
      let text = "";
      // Set from the stream callback; a holder keeps TS from narrowing it to null.
      const done: { result: CliResult | null } = { result: null };
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      let buf = "";
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: { type?: string; event?: { type?: string; delta?: { type?: string; text?: string } }; result?: string };
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === "stream_event" && ev.event?.type === "message_start") {
            text = "";
            r.onTurn();
          } else if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta") {
            text += ev.event.delta.text ?? "";
            r.onText(ev.event.delta.text ?? "");
          } else if (ev.type === "result") {
            done.result = ev as CliResult;
          }
        }
      });
      const code = await new Promise<number | null>((res) => child.on("close", res));
      r.signal?.removeEventListener("abort", onAbort);
      server.close();
      fs.rm(dir, { recursive: true, force: true }, () => {});
      const f = done.result;
      if (!f) throw new Error(`claude exited ${code}: ${stderr.trim().slice(0, 500) || "no result"}`);
      if (f.is_error) throw new Error(`claude: ${f.result ?? "error"}`);
      const u = f.usage ?? {};
      return {
        text: f.result ?? text,
        model: o.model,
        usage: {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
          costUSD: f.total_cost_usd,
        },
      };
    },
  };
}

// ── choosing one ─────────────────────────────────────────

export interface BackendChoice {
  /** auto: the Anthropic API with ANTHROPIC_API_KEY, else the claude login. */
  provider?: string;
  model?: string;
  effort?: string;
  baseURL?: string;
  apiKey?: string;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

export function backendFor(c: BackendChoice): Backend {
  const model = c.model || DEFAULT_MODEL;
  const provider = !c.provider || c.provider === "auto" ? (process.env.ANTHROPIC_API_KEY ? "anthropic" : claudeCliAvailable() ? "claude-cli" : undefined) : c.provider;
  if (provider === "anthropic") {
    return aiBackend({ provider: "anthropic", model, apiKey: c.apiKey ?? process.env.ANTHROPIC_API_KEY, effort: (c.effort as AiBackendOptions["effort"]) ?? "low" });
  }
  if (provider === "openai-compatible") {
    return aiBackend({ provider: "openai-compatible", model, baseURL: c.baseURL, apiKey: c.apiKey ?? process.env.CMD_MAGIC_API_KEY });
  }
  if (provider === "claude-cli") return claudeCliBackend({ model });
  throw new Error("No model provider: set ANTHROPIC_API_KEY, choose an OpenAI-compatible endpoint in Settings, or install and log in to the claude CLI.");
}
