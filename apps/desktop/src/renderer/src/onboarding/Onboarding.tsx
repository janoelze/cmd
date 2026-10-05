// The onboarding sheet: the steps of steps.tsx, one at a time, with Back and
// Continue. Opens by itself after a launch with the steps this Mac hasn't seen
// (main/onboarding.ts), from "Set Up cmd…" with all of them, and from a
// feature that needs one step (a Magic widget without an AI provider: just
// "ai"). Whatever it showed counts as seen when it closes, done or skipped.

import { useState, useSyncExternalStore } from "react";
import { Button, Dialog, PageDots } from "@cmd/ui";
import { cmd } from "../bridge.ts";
import { aiStatus, useAiStatus } from "../ai/status.ts";
import { STEPS, stepById, type OnboardingStep } from "./steps.tsx";
import { AppIcon } from "./AppIcon.tsx";
import type { OnboardingClaim } from "../../../main/onboarding.ts";
import "./onboarding.css";

// ── what is open (any component can ask for a step) ─────

let open: readonly string[] | null = null;
const listeners = new Set<() => void>();
const set = (ids: readonly string[] | null) => ((open = ids), listeners.forEach((fn) => fn()));

/** Open the sheet at these steps (default: all of them). */
export function showSetup(ids: readonly string[] = STEPS.map((s) => s.id)): void {
  set(ids);
}

/** Close it: what it showed counts as seen. */
export function closeSetup(): void {
  if (open) cmd.onboardingSeen([...open]);
  set(null);
}

export function useSetup(): readonly string[] | null {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => open,
  );
}

/** At launch: the steps this Mac should see now, or none. Waits for the AI status (a step may be done already). */
export async function stepsAtLaunch(claim: OnboardingClaim | null): Promise<string[]> {
  if (!claim) return [];
  const due = STEPS.filter((s) => !claim.seen.includes(s.id) && (claim.newInstall || s.existingUsers));
  if (!due.length) return [];
  const ai = await new Promise<ReturnType<typeof aiStatus>>((resolve) => {
    const deadline = Date.now() + 5000;
    const poll = () => (aiStatus() || Date.now() > deadline ? resolve(aiStatus()) : setTimeout(poll, 50));
    poll();
  });
  const skip = due.filter((s) => s.done?.({ ai }));
  // Done already counts as seen: it won't come back when the user removes the key.
  if (skip.length) cmd.onboardingSeen(skip.map((s) => s.id));
  return due.filter((s) => !skip.includes(s)).map((s) => s.id);
}

// ── the sheet ────────────────────────────────────────────

/** onClose: call closeSetup (the app also shows What's New after it, if it waited). */
export function Onboarding({ ids, onClose }: { ids: readonly string[]; onClose: () => void }) {
  const ai = useAiStatus();
  const steps = ids.map(stepById).filter((s): s is OnboardingStep => !!s);
  const [at, setAt] = useState(0);
  const step = steps[at];
  if (!step) return null;
  const ctx = { ai };
  const last = at === steps.length - 1;
  const ready = step.ready?.(ctx) ?? true;
  const next = () => (last ? onClose() : setAt(at + 1));
  return (
    <Dialog open onClose={onClose} width={440} padded={false} className="onboarding" position="center" label={step.title}>
      <div className="ob-sheet">
        <AppIcon size={56} />
        <div className="ob-step" key={step.id}>
          <h1 className="ob-title">{step.title}</h1>
          <p className="ob-subtitle">{step.subtitle}</p>
          {step.body && <div className="ob-body">{step.body(ctx)}</div>}
        </div>
        <div className="ob-foot">
          {steps.length > 1 && (
            <span className="ob-progress">
              <PageDots count={steps.length} current={at} label={`Step ${at + 1} of ${steps.length}`} />
            </span>
          )}
          {at > 0 && (
            <Button variant="ghost" size="lg" onClick={() => setAt(at - 1)}>
              Back
            </Button>
          )}
          {!ready && (
            <Button size="lg" onClick={next}>
              Set Up Later
            </Button>
          )}
          <Button variant="primary" size="lg" disabled={!ready} onClick={next}>
            {step.primary ?? (last ? "Done" : "Continue")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
