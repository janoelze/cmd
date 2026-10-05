// The models a provider offers to the user's API key: for the model popups,
// for checking a key, and for picking each tier's model (pickModel). Both
// providers list exactly what the key can use at GET /v1/models:
// - Anthropic: id, display_name, created_at; paginated (limit ≤ 1000, has_more,
//   last_id → after_id). Every model there is a chat model.
// - OpenAI: id, created, owned_by; one page, everything the key can call,
//   including embeddings, audio and image models, so only chat models are kept.

import type { AiModel, AiProvider, AiTier } from "@cmd/protocol";

type Fetch = typeof fetch;

/** The provider refused the key (HTTP 401): it is wrong or revoked, not just unreachable. */
export class KeyRejected extends Error {}

/**
 * The families a tier picks from, best first: the newest model of the first
 * family the key has. A new version of a family (Opus 5.5 → 5.6, GPT-5.5 → 6)
 * needs no change here; a new family name does.
 */
export const TIER_FAMILIES: Record<AiProvider, Record<AiTier, RegExp[]>> = {
  anthropic: { smart: [/^claude-opus-\d/], fast: [/^claude-haiku-\d/] },
  // Aliases only (isOpenAIChatModel drops snapshots); not -mini/-nano/-pro for smart.
  openai: { smart: [/^gpt-\d+(\.\d+)?$/], fast: [/^gpt-\d+(\.\d+)?-mini$/] },
};

/** When the key's models can't be listed (offline, never checked): a model each tier is known to have. */
export const FALLBACK_MODELS: Record<AiProvider, Record<AiTier, string>> = {
  anthropic: { smart: "claude-opus-5-5", fast: "claude-haiku-4-5" },
  openai: { smart: "gpt-5.5", fast: "gpt-5-mini" },
};

/** The model `tier` uses from a key's list: the newest of its first family present, or undefined. */
export function pickModel(provider: AiProvider, tier: AiTier, list: readonly AiModel[]): AiModel | undefined {
  for (const family of TIER_FAMILIES[provider][tier]) {
    const found = list.filter((m) => family.test(m.id));
    // Lists come newest first; release times, where given, decide.
    if (found.length) return found.reduce((best, m) => ((m.created ?? 0) > (best.created ?? 0) ? m : best));
  }
  return undefined;
}

/**
 * OpenAI ids worth offering for AI features: chat models (text in and out,
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

export async function listModels(provider: AiProvider, apiKey: string, o: { fetch?: Fetch; signal?: AbortSignal } = {}): Promise<AiModel[]> {
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
      if (res.status === 401) throw new KeyRejected("The key was not accepted.");
      throw new Error(`${provider}: HTTP ${res.status}${msg ? `: ${msg}` : ""}`);
    }
    return res.json() as Promise<Record<string, unknown>>;
  };

  if (provider === "anthropic") {
    const out: AiModel[] = [];
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
