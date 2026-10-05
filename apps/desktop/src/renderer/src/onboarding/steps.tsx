// The onboarding steps, in order (docs/16-ai.md, "Onboarding"). A new install
// sees every step; after an update, only steps marked `existingUsers` that this
// Mac hasn't seen (main/onboarding.ts). A step whose work is already done (a
// key carried over from Magic widgets) is left out. Adding a step later (a
// theme, …) means adding an entry here.

import type { ReactNode } from "react";
import type { AiStatus } from "@cmd/protocol";
import { FormSection } from "@cmd/ui";
import { AiKeyRow, AiProviderChoice } from "../ai/Providers.tsx";

export interface StepContext {
  ai: AiStatus | null;
}

export interface OnboardingStep {
  id: string;
  title: string;
  /** One line under the title. */
  subtitle: string;
  body?: (c: StepContext) => ReactNode;
  /** Also shown to people who used cmd before this step existed. */
  existingUsers?: boolean;
  /** Nothing to do here: leave the step out. */
  done?: (c: StepContext) => boolean;
  /** The primary button works (else only "Set Up Later" moves on). Default: always. */
  ready?: (c: StepContext) => boolean;
  /** The primary button's label (default: "Continue", or "Done" on the last step). */
  primary?: string;
}

const welcome: OnboardingStep = {
  id: "welcome",
  title: "Welcome to cmd",
  subtitle: "Terminals and coding agents, side by side.",
  primary: "Get Started",
};

const ai: OnboardingStep = {
  id: "ai",
  title: "Connect an AI provider",
  subtitle: "Required for smart features in cmd. Your keys stay on your PC.",
  existingUsers: true,
  done: (c) => !!c.ai?.ready,
  ready: (c) => !!c.ai?.ready,
  body: () => (
    <FormSection>
      <AiKeyRow provider="anthropic" autoFocus stacked />
      <AiKeyRow provider="openai" stacked />
      <AiProviderChoice />
    </FormSection>
  ),
};

export const STEPS: readonly OnboardingStep[] = [welcome, ai];

export const stepById = (id: string): OnboardingStep | undefined => STEPS.find((s) => s.id === id);
