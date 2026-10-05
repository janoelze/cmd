// Workbench stories (pnpm workbench onboarding): the onboarding sheet. The
// Workbench's core has no AI key, so the AI step waits for one.
import { Onboarding } from "./Onboarding.tsx";

const noop = () => {};

export const Welcome = () => <Onboarding ids={["welcome", "ai"]} onClose={noop} />;
export const AI = () => <Onboarding ids={["ai"]} onClose={noop} />;
