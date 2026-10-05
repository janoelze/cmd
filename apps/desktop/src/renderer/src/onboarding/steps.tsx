// The onboarding steps, in order (docs/17-ai.md, "Onboarding"). A new install
// sees every step; after an update, only steps marked `existingUsers` that this
// Mac hasn't seen (main/onboarding.ts). A step whose work is already done (a
// key carried over from Magic widgets) is left out. Adding a step later (a
// theme, …) means adding an entry here.

import type { ReactNode } from "react";
import type { AiStatus } from "@cmd/protocol";
import { FeatureList, FormSection } from "@cmd/ui";
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
  body: () => (
    <FeatureList
      items={[
        { icon: "rectangle.3.group", title: "One desk", description: "Terminals, agents, a browser and an editor as windows, in a grid, a strip or on a canvas." },
        { icon: "terminal", title: "Agents in your terminals", description: "Claude Code and Codex show up in any terminal. The one that needs you is on top." },
        { icon: "wand.and.stars", title: "Magic widgets", description: "Ask for a window, like your open merge requests, and an agent builds it." },
        { icon: "command", title: "Everything on ⌘K", description: "Windows, sessions and commands, one keystroke away." },
      ]}
    />
  ),
};

const ai: OnboardingStep = {
  id: "ai",
  title: "Connect an AI provider",
  subtitle: "Your keys stay on this Mac.",
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
