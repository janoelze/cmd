// Workbench stories (pnpm workbench feedback): the feedback sheet, with a stand-in
// for main's webhook. Sent and Fails press Send themselves to reach their state.
import { useEffect } from "react";
import { Feedback, type FeedbackApi } from "./Feedback.tsx";

const noop = () => {};
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const api = (send: FeedbackApi["sendFeedback"], reason: string | null = null): FeedbackApi => ({ feedbackStatus: async () => ({ available: !reason, reason }), sendFeedback: send });
const works = api(() => wait(600));
const draft = { kind: "bug" as const, message: "The Dock badge stays at 1 after I answered the agent." };

/** Presses the sheet's Send button once it can. */
function useSend() {
  useEffect(() => {
    const t = setInterval(() => {
      const b = document.querySelector<HTMLButtonElement>(".ui-dialog [data-variant=primary]:not(:disabled)");
      if (b) (b.click(), clearInterval(t));
    }, 50);
    return () => clearInterval(t);
  }, []);
}

export const Empty = () => <Feedback onClose={noop} api={works} />;
export const Filled = () => <Feedback onClose={noop} api={works} initial={draft} />;
export const DevBuild = () => <Feedback onClose={noop} api={api(works.sendFeedback, "Development builds can't send feedback (set $CMD_FEEDBACK_WEBHOOK).")} initial={draft} />;
export const Fails = () => {
  useSend();
  return <Feedback onClose={noop} api={api(() => Promise.reject(new Error("The feedback server didn't answer. Try again in a minute.")))} initial={draft} />;
};
export const Sent = () => {
  useSend();
  return <Feedback onClose={noop} api={api(async () => {})} initial={draft} />;
};
