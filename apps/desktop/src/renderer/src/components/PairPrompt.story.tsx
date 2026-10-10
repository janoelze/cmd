// Workbench stories (pnpm workbench pairprompt): "Allow “iPhone” to use cmd?", as the
// main window's sheet shows it, and inline as Settings does.

import type { RemotePairRequest } from "@cmd/protocol";
import { FormSection, Stack } from "@cmd/ui";
import { PairPrompt, PairSheet } from "./PairPrompt.tsx";

const request = { requestId: "r1", name: "Jan's iPhone", words: ["maple", "harbor", "violet", "comet"], expiresAt: Date.now() + 4 * 60_000 } as unknown as RemotePairRequest;

export const Sheet = () => <PairSheet request={request} />;
/** Settings → Remote Access, inline. */
export const Inline = () => (
  <div style={{ width: 560 }}>
    <FormSection title="Pair a Device">
      <Stack pad="xl">
        <PairPrompt request={request} autoFocus={false} />
      </Stack>
    </FormSection>
  </div>
);
