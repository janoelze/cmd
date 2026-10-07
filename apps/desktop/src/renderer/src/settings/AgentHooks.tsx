// Settings → Agents → Hooks: each coding agent's config file and whether cmd's
// hook is in it, with Install/Remove (core: agents/hooks.ts). The hook is how an
// agent reports its state to the sidebar and gets peer briefings.

import { useEffect, useState } from "react";
import type { HookTarget } from "@cmd/protocol";
import { Button, FormRow, FormSection } from "@cmd/ui";
import { cmd } from "../bridge.ts";
import { shortPath } from "../model.ts";

const STATE: Record<HookTarget["state"], { text: string; tone: "accent" | "warning" | "dim" }> = {
  installed: { text: "Installed.", tone: "dim" },
  missing: { text: "Not installed.", tone: "dim" },
  legacy: { text: "Has an older version of the hook. Install replaces it.", tone: "warning" },
  elsewhere: { text: "Has the hook of another cmd (e.g. a development build). Install points it here.", tone: "warning" },
  stale: { text: "Has a cmd hook whose script is gone. Install replaces it.", tone: "warning" },
};

const tilde = shortPath;

export function AgentHooks() {
  const [targets, setTargets] = useState<HookTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => void cmd.call("hooks.status", {}).then(setTargets, (e: Error) => setError(e.message)), []);

  const act = (method: "hooks.install" | "hooks.remove", file: string) => {
    setBusy(file);
    cmd
      .call(method, { file })
      .then((t) => (setTargets(t), setError(null)), (e: Error) => setError(e.message))
      .finally(() => setBusy(null));
  };

  return (
    <FormSection title="Hooks">
      {targets?.length === 0 && <FormRow title="No coding agents found" description="Claude Code, Codex and Gemini CLI keep their settings in your home folder; none are there yet." />}
      {targets?.map((t) => {
        const s = STATE[t.state];
        const codex = t.agent === "codex" && t.state === "installed";
        return (
          <FormRow
            key={t.file}
            title={t.title}
            description={tilde(t.file)}
            note={codex ? "Installed. Codex runs it once you approve it: run /hooks in Codex." : t.declined && t.state === "missing" ? "Not installed. You removed it, so cmd won't add it by itself." : s.text}
            noteTone={codex ? "accent" : s.tone}
          >
            {t.state === "installed" ? (
              <Button disabled={busy === t.file} onClick={() => act("hooks.remove", t.file)}>
                Remove
              </Button>
            ) : (
              <Button variant="primary" disabled={busy === t.file} onClick={() => act("hooks.install", t.file)}>
                Install
              </Button>
            )}
          </FormRow>
        );
      })}
      {error && <FormRow title="Couldn't change the hook" note={error} noteTone="danger" />}
    </FormSection>
  );
}
