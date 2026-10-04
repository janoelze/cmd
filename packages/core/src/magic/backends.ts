// Model backends for the Magic agent: the Vercel AI SDK, with the provider and
// model the user chose (magic.provider, magic.<provider>.model) and the API key
// they stored (secrets). Nothing is discovered: no environment variables, no
// CLI logins. The loop runs here; the tools always execute in-process through
// `exec` (see tools.ts), so the policy, the sandbox and the budget are the same
// for every provider.

// The AI SDK is imported when a run starts, not with the core: a problem with
// it (or with a provider package) can break Magic windows, never the core.
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { MAGIC_PROVIDERS, type MagicProvider } from "@cmd/protocol";
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
  provider: MagicProvider;
  model: string;
  apiKey: string;
  /** How hard the model thinks: low keeps Magic fast. Sent only to models that take it. */
  effort?: "low" | "medium" | "high";
}

async function languageModel(o: AiBackendOptions): Promise<LanguageModel> {
  if (o.provider === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic({ apiKey: o.apiKey })(o.model);
  }
  const { createOpenAI } = await import("@ai-sdk/openai");
  return createOpenAI({ apiKey: o.apiKey })(o.model); // the Responses API
}

/** Effort for the models that take it: Anthropic's newer models, OpenAI's reasoning models. */
function effortOptions(o: AiBackendOptions): Record<string, Record<string, string>> | undefined {
  const effort = o.effort ?? "low";
  if (o.provider === "anthropic") return /haiku|claude-3|-4-5|-4-1|-4-0|sonnet-4-0/.test(o.model) ? undefined : { anthropic: { effort } };
  return /^(o\d|gpt-5|gpt-6)/.test(o.model) ? { openai: { reasoningEffort: effort } } : undefined;
}

export function aiBackend(o: AiBackendOptions): Backend {
  return {
    name: o.provider,
    model: o.model,
    async run(r) {
      const { jsonSchema, stepCountIs, streamText, tool } = await import("ai");
      const model = await languageModel(o);
      const tools: ToolSet = {};
      for (const spec of r.tools) {
        tools[spec.name] = tool({
          description: spec.description,
          inputSchema: jsonSchema(spec.schema as never),
          execute: async (input: unknown) => r.exec(spec.name, (input ?? {}) as Record<string, unknown>),
          // Text, plus the preview's screenshots so the model sees what it made.
          toModelOutput: ({ output }: { output: ToolOutput }) => {
            const text = output.isError ? `Error: ${output.output}` : output.output;
            return output.images?.length
              ? { type: "content" as const, value: [{ type: "text" as const, text }, ...output.images.map((data) => ({ type: "image-data" as const, data, mediaType: "image/png" }))] }
              : { type: "text" as const, value: text };
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
        maxOutputTokens: 32_000,
        providerOptions: effortOptions(o),
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

// ── choosing one ─────────────────────────────────────────

export interface BackendChoice {
  provider: string;
  model: string;
  /** The provider's stored key (secrets); undefined when the user hasn't set one. */
  apiKey: string | undefined;
  effort?: AiBackendOptions["effort"];
}

export function isProvider(p: string): p is MagicProvider {
  return Object.hasOwn(MAGIC_PROVIDERS, p);
}

export function backendFor(c: BackendChoice): Backend {
  if (!isProvider(c.provider)) throw new Error(`Unknown provider "${c.provider}": choose Anthropic or OpenAI in Settings → Magic Windows.`);
  const title = MAGIC_PROVIDERS[c.provider].title;
  if (!c.apiKey) throw new Error(`No ${title} API key: add one in Settings → Magic Windows.`);
  if (!c.model.trim()) throw new Error(`No ${title} model: choose one in Settings → Magic Windows.`);
  return aiBackend({ provider: c.provider, model: c.model.trim(), apiKey: c.apiKey, effort: c.effort });
}
