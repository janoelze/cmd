// Feedback from the app (Help → Send Feedback…, the status bar) to a Discord
// webhook. Like crash reports (crash.ts), the webhook is baked in at build time
// from $CMD_FEEDBACK_WEBHOOK (a CI secret; electron.vite.config.ts), so the URL
// isn't in the repository. Development builds can't send unless
// $CMD_FEEDBACK_WEBHOOK is set when they run.

import { crashContext, logger } from "@cmd/protocol/node";
import { FEEDBACK_KINDS, feedbackPayload, type Feedback, type FeedbackKind } from "./feedback-format.ts";

declare const __FEEDBACK_WEBHOOK__: string;
const BAKED = typeof __FEEDBACK_WEBHOOK__ === "string" ? __FEEDBACK_WEBHOOK__ : "";

const log = logger("feedback");
const MAX_PER_HOUR = 10;
const sentAt: number[] = [];

let webhook = "";

export interface FeedbackStatus {
  /** Feedback can be sent from this build. */
  available: boolean;
  /** Why not, when not. */
  reason: string | null;
}

export interface FeedbackRequest {
  kind: FeedbackKind;
  message: string;
  contact?: string;
  /** Attach version, platform… */
  includeInfo: boolean;
}

export function startFeedback(devBuild: boolean): void {
  webhook = process.env.CMD_FEEDBACK_WEBHOOK || (devBuild ? "" : BAKED);
}

export function feedbackStatus(devBuild: boolean): FeedbackStatus {
  const reason = webhook ? null : devBuild ? "Development builds can't send feedback (set $CMD_FEEDBACK_WEBHOOK)." : "This build has no feedback address.";
  return { available: !reason, reason };
}

/** Resolves when Discord took it; rejects with a message for the form otherwise. */
export async function sendFeedback(r: FeedbackRequest, context: Record<string, string>): Promise<void> {
  if (!webhook) throw new Error("This build can't send feedback.");
  const message = String(r.message ?? "").trim();
  if (!message) throw new Error("Write something first.");
  const hourAgo = Date.now() - 60 * 60_000;
  while ((sentAt[0] ?? Infinity) < hourAgo) sentAt.shift();
  if (sentAt.length >= MAX_PER_HOUR) throw new Error("That's a lot of feedback for one hour. Try again later.");
  const f: Feedback = {
    kind: FEEDBACK_KINDS.includes(r.kind) ? r.kind : "other",
    message,
    contact: r.contact,
    context: r.includeInfo ? crashContext(context) : undefined,
  };
  let res: Response;
  try {
    res = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(feedbackPayload(f)),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    log.warn(`feedback not sent: ${(err as Error).message}`);
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }
  if (!res.ok) {
    log.warn(`feedback rejected: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    throw new Error(res.status === 429 ? "Too many messages right now. Try again in a minute." : `The server refused it (HTTP ${res.status}).`);
  }
  sentAt.push(Date.now());
  log.info(`feedback sent (${f.kind})`);
}
