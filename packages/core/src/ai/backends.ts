// Model calls through the Vercel AI SDK, for a provider, model and key the
// AiService chose (service.ts): an agent loop (Backend.run, Magic), one text
// completion, or one object matching a JSON schema. Nothing is discovered: no
// environment variables, no CLI logins. In an agent loop the tools execute
// in-process through `exec` (magic/tools.ts), so the policy, the sandbox and
// the budget are the same for every provider.

// The AI SDK is imported when a call starts, not with the core: a problem with
// it (or with a provider package) can break AI features, never the core.
import type { LanguageModel, LanguageModelUsage, ModelMessage, ToolSet } from "ai";
import type { AiProvider } from "@cmd/protocol";
import type { ToolOutput, ToolSpec } from "../magic/tools.ts";

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
  provider: AiProvider;
  model: string;
  apiKey: string;
  /** How hard the model thinks: low keeps calls fast. Sent only to models that take it. */
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
      return { text, model: o.model, usage: usageOf(await result.totalUsage) };
    },
  };
}

function usageOf(u: LanguageModelUsage): Usage {
  const details = (u as { inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } }).inputTokenDetails;
  return {
    input: u.inputTokens ?? 0,
    output: u.outputTokens ?? 0,
    cacheRead: details?.cacheReadTokens ?? (u as { cachedInputTokens?: number }).cachedInputTokens ?? 0,
    cacheWrite: details?.cacheWriteTokens ?? 0,
  };
}

// ── one-shot calls ───────────────────────────────────────

export interface CompleteRequest {
  system?: string;
  prompt: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
}

export interface CompleteResult<T> {
  value: T;
  usage: Usage;
  model: string;
}

/** One answer as text. */
export async function completeText(o: AiBackendOptions, r: CompleteRequest): Promise<CompleteResult<string>> {
  const { generateText } = await import("ai");
  const res = await generateText({
    model: await languageModel(o),
    instructions: r.system,
    prompt: r.prompt,
    abortSignal: r.signal,
    maxOutputTokens: r.maxOutputTokens ?? 4000,
    providerOptions: effortOptions(o),
  });
  return { value: res.text, usage: usageOf(res.totalUsage), model: o.model };
}

export interface ObjectRequest<T> extends CompleteRequest {
  schema: Record<string, unknown>;
  /** Streams: called with the object as it fills (fields missing or cut short, never checked). */
  onPartial?: (partial: Partial<T>) => void;
}

/** One answer as an object matching `schema` (a JSON schema; checked by the SDK). */
export async function completeObject<T>(o: AiBackendOptions, r: ObjectRequest<T>): Promise<CompleteResult<T>> {
  const { generateText, streamText, jsonSchema, Output } = await import("ai");
  const call = {
    model: await languageModel(o),
    instructions: r.system,
    prompt: r.prompt,
    abortSignal: r.signal,
    maxOutputTokens: r.maxOutputTokens ?? 4000,
    providerOptions: effortOptions(o),
    output: Output.object({ schema: jsonSchema<T>(r.schema as never) }),
  };
  if (!r.onPartial) {
    const res = await generateText(call);
    return { value: res.output as T, usage: usageOf(res.totalUsage), model: o.model };
  }
  // A failed stream only ends the partials; the error is kept and thrown after them.
  let failed: unknown = null;
  const res = streamText({ ...call, onError: ({ error }) => void (failed ??= error) });
  for await (const partial of res.partialOutputStream) r.onPartial(partial as Partial<T>);
  if (failed) throw failed instanceof Error ? failed : new Error(String(failed));
  return { value: (await res.output) as T, usage: usageOf(await res.totalUsage), model: o.model };
}
