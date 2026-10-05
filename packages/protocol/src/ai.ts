// AI providers (docs/17-ai.md): one place every feature gets a model from. The
// user brings a key for at least one provider (onboarding or Settings → AI);
// features ask the core's AiService for a tier, never a model, and each tier
// resolves to the newest model of a family the key can use unless pinned.

/** Quality for agent loops (Magic), or speed for short tasks (summaries, notifications). */
export type AiTier = "smart" | "fast";

export const AI_PROVIDERS = {
  anthropic: {
    title: "Anthropic",
    /** What its models are called, for copy ("Claude models"). */
    models: "Claude",
    keySecret: "ai.anthropic.apiKey",
    keyUrl: "https://console.anthropic.com/settings/keys",
    tiers: { smart: "ai.anthropic.model", fast: "ai.anthropic.fastModel" },
  },
  openai: {
    title: "OpenAI",
    models: "GPT",
    keySecret: "ai.openai.apiKey",
    keyUrl: "https://platform.openai.com/api-keys",
    tiers: { smart: "ai.openai.model", fast: "ai.openai.fastModel" },
  },
} as const;
export type AiProvider = keyof typeof AI_PROVIDERS;
export const AI_PROVIDER_IDS = Object.keys(AI_PROVIDERS) as AiProvider[];

export function isAiProvider(p: string): p is AiProvider {
  return Object.hasOwn(AI_PROVIDERS, p);
}

/** A tier's setting value that lets the core pick the model. */
export const AUTO_MODEL = "auto";

/** A model a provider offers to the user's key (ai.models). */
export interface AiModel {
  id: string;
  /** Display name, where the provider gives one. */
  name: string;
  /** Release time, ms (newest first in lists). */
  created?: number;
}

/** The model a tier uses right now. */
export interface AiModelChoice {
  id: string;
  name: string;
  /** Picked by the core (the setting is "auto"), not pinned by the user. */
  auto: boolean;
}

export interface AiProviderStatus {
  /** Whether a key is stored, and its last four characters. */
  key: { set: boolean; hint?: string };
  /**
   * none: no key. ok: the provider accepted it. unchecked: stored but not
   * confirmed yet (offline, or not asked yet). rejected: the provider refused it.
   */
  state: "none" | "ok" | "unchecked" | "rejected";
  /** Why it is rejected, or why checking failed. */
  error?: string;
  /** What each tier resolves to (absent without a key). */
  models?: Record<AiTier, AiModelChoice>;
}

export interface AiStatus {
  /** A provider with a key the provider hasn't refused: AI features can run. */
  ready: boolean;
  /** The provider features use: ai.provider if it has a key, else one that does. */
  provider: AiProvider | null;
  providers: Record<AiProvider, AiProviderStatus>;
}
