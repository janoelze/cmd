// Secrets: values that must never sit in settings.json (it is plain text, often
// kept in dotfiles, broadcast to every client and printed by `cmd settings`).
// The core keeps them in $CMD_HOME/secrets.json, readable only by the user, and
// clients only ever see whether each is set and its last four characters.

export interface SecretDef {
  title: string;
  description: string;
  placeholder?: string;
}

export const SECRETS = {
  "ai.anthropic.apiKey": {
    title: "Anthropic API key",
    placeholder: "sk-ant-…",
    description: "For Claude models. Create one at console.anthropic.com → API Keys.",
  },
  "ai.openai.apiKey": {
    title: "OpenAI API key",
    placeholder: "sk-…",
    description: "For GPT models. Create one at platform.openai.com → API keys.",
  },
} as const satisfies Record<string, SecretDef>;

export type SecretKey = keyof typeof SECRETS;

/** What clients see of a secret: whether it is set, and its last four characters. */
export type SecretsStatus = Record<SecretKey, { set: boolean; hint?: string }>;

export function isSecretKey(key: string): key is SecretKey {
  return Object.hasOwn(SECRETS, key);
}

/** Keys that were renamed (old → new): old secrets files and `cmd settings secret` keep working. */
export const RENAMED_SECRETS: Readonly<Record<string, SecretKey>> = {
  "magic.anthropic.apiKey": "ai.anthropic.apiKey",
  "magic.openai.apiKey": "ai.openai.apiKey",
};

/** The current name of a secret (renamed ones map to their new name). */
export const currentSecretKey = (key: string): string => RENAMED_SECRETS[key] ?? key;
