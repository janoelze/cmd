// The models a provider offers to the user's API key, for the model setting's
// popup. Both providers list exactly what the key can use at GET /v1/models:
// - Anthropic: id, display_name, created_at; paginated (limit ≤ 1000, has_more,
//   last_id → after_id). Every model there is a chat model.
// - OpenAI: id, created, owned_by; one page, everything the key can call,
//   including embeddings, audio and image models, so only chat models are kept.

import type { MagicModel, MagicProvider } from "@cmd/protocol";

type Fetch = typeof fetch;

/**
 * OpenAI ids worth offering for the Magic agent: chat models (text in and out,
 * tool calls), by their alias only. Dated snapshots (gpt-5.5-2026-04-23,
 * gpt-3.5-turbo-0125) duplicate an alias; a pinned one can still be set in
 * settings.json. GPT-3.5 and the original GPT-4 are left out as too weak.
 */
export function isOpenAIChatModel(id: string): boolean {
  if (!/^(gpt-|o\d|chatgpt-)/.test(id)) return false;
  if (/-\d{4}-\d{2}-\d{2}$|-\d{4}$/.test(id)) return false;
  if (/^gpt-3\.5|^gpt-4($|-)/.test(id)) return false;
  return !/(audio|realtime|live|transcribe|tts|image|embedding|search|moderation|instruct|computer-use|dall-e|whisper)/.test(id);
}

export async function listModels(provider: MagicProvider, apiKey: string, o: { fetch?: Fetch; signal?: AbortSignal } = {}): Promise<MagicModel[]> {
  const f = o.fetch ?? fetch;
  const signal = o.signal ?? AbortSignal.timeout(15_000);
  const get = async (url: string, headers: Record<string, string>) => {
    const res = await f(url, { headers, signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const msg = (() => {
        try {
          return (JSON.parse(body) as { error?: { message?: string } }).error?.message;
        } catch {
          return undefined;
        }
      })();
      throw new Error(res.status === 401 ? "The API key was not accepted." : `${provider}: HTTP ${res.status}${msg ? `: ${msg}` : ""}`);
    }
    return res.json() as Promise<Record<string, unknown>>;
  };

  if (provider === "anthropic") {
    const out: MagicModel[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = `https://api.anthropic.com/v1/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
      const r = (await get(url, { "x-api-key": apiKey, "anthropic-version": "2023-06-01" })) as {
        data?: { id: string; display_name?: string; created_at?: string }[];
        has_more?: boolean;
        last_id?: string | null;
      };
      for (const m of r.data ?? []) out.push({ id: m.id, name: m.display_name || m.id, created: m.created_at ? Date.parse(m.created_at) || undefined : undefined });
      if (!r.has_more || !r.last_id) break;
      after = r.last_id;
    }
    return out; // already newest first
  }

  const r = (await get("https://api.openai.com/v1/models", { authorization: `Bearer ${apiKey}` })) as { data?: { id: string; created?: number }[] };
  return (r.data ?? [])
    .filter((m) => isOpenAIChatModel(m.id))
    .map((m) => ({ id: m.id, name: m.id, created: m.created ? m.created * 1000 : undefined }))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
}
