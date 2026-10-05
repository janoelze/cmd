// AI provider rows (docs/17-ai.md), the same in onboarding and Settings → AI:
// one row per provider with its key, checked with the provider as soon as it is
// pasted (ai.connect), and a line saying what that key gets you or what is wrong.
// With keys for both, a row to choose which one features use.

import { useState } from "react";
import { AI_PROVIDER_IDS, AI_PROVIDERS, type AiProvider, type AiProviderStatus, type AiStatus } from "@cmd/protocol";
import { FormRow, LinkButton, Segmented, SecretField, type SecretStatus } from "@cmd/ui";
import { cmd } from "../bridge.ts";
import { useAiStatus } from "./status.ts";

/** What a provider's key gets you, or what is wrong with it. */
function statusNote(st: AiProviderStatus | undefined): { text: string; tone: "accent" | "warning" | "danger" } | null {
  if (!st || st.state === "none") return null;
  if (st.state === "rejected") return { text: st.error ?? "The provider didn't accept this key.", tone: "danger" };
  if (st.state === "unchecked") return { text: st.error ?? "Not checked yet.", tone: "warning" };
  return { text: st.models ? `Ready · ${st.models.smart.name} and ${st.models.fast.name}` : "Ready", tone: "accent" };
}

/** What the provider said about the stored key, attached to the field. */
function keyStatus(st: AiProviderStatus | undefined): SecretStatus | undefined {
  if (!st?.key.set) return undefined;
  if (st.state === "ok") return { tone: "success", label: "Accepted" };
  if (st.state === "rejected") return { tone: "danger", label: "Rejected", tip: st.error };
  return { tone: "warning", label: "Not checked", tip: st.error };
}

/** A provider's key: checked with the provider as it is entered, so a mistyped key never gets stored. */
/** stacked: the field under the name, full width (onboarding's narrower sheet). */
export function AiKeyRow({ provider, autoFocus, stacked }: { provider: AiProvider; autoFocus?: boolean; stacked?: boolean }) {
  const ai = useAiStatus();
  const def = AI_PROVIDERS[provider];
  const st = ai?.providers[provider];
  const [error, setError] = useState<string | null>(null);
  const connect = (key: string | null) =>
    cmd.call("ai.connect", { provider, key }).then(
      () => setError(null),
      (e: Error) => {
        setError(e.message);
        throw e;
      },
    );
  const note = error ? { text: error, tone: "danger" as const } : statusNote(st);
  return (
    <FormRow
      title={def.title}
      tip={def.keySecret}
      titleAside={
        (!st?.key.set || st.state === "rejected") && (
          <LinkButton data-tip={`Create one at ${new URL(def.keyUrl).host}`} onClick={() => cmd.openPath(def.keyUrl)}>
            Get a key
          </LinkButton>
        )
      }
      note={note?.text}
      noteTone={note?.tone}
      stacked={stacked}
    >
      <SecretField set={!!st?.key.set} hint={st?.key.hint} placeholder="Paste an API key" autoFocus={autoFocus} fill={stacked} size={stacked ? "lg" : undefined} live status={keyStatus(st)} onSave={connect} />
    </FormRow>
  );
}

/** Providers whose key works (or can't be checked yet). */
export const usableProviders = (ai: AiStatus | null): AiProvider[] => AI_PROVIDER_IDS.filter((p) => ai?.providers[p].key.set && ai.providers[p].state !== "rejected");

/** Which provider features use, once more than one can be. */
export function AiProviderChoice() {
  const ai = useAiStatus();
  const usable = usableProviders(ai);
  if (usable.length < 2 || !ai?.provider) return null;
  return (
    <FormRow title="Use" tip="ai.provider" description="AI features use this one.">
      <Segmented
        value={ai.provider}
        options={usable}
        labels={Object.fromEntries(usable.map((p) => [p, AI_PROVIDERS[p].title]))}
        onChange={(v) => void cmd.call("settings.set", { key: "ai.provider", value: v })}
      />
    </FormRow>
  );
}
