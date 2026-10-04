// What feedback looks like on its way out (main/feedback.ts): the Discord
// message, with home folders scrubbed and mentions disabled.

import { scrub } from "./crash-format.ts";

export const FEEDBACK_KINDS = ["idea", "bug", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface Feedback {
  kind: FeedbackKind;
  message: string;
  /** How to reach the sender, if they want an answer. */
  contact?: string;
  /** Version, platform… (crashContext); absent when the sender left it out. */
  context?: Record<string, string>;
}

const TITLE: Record<FeedbackKind, string> = { idea: "Idea", bug: "Bug", other: "Feedback" };
const COLOR: Record<FeedbackKind, number> = { idea: 0x3e9bf5, bug: 0xe5484d, other: 0x8e8e93 };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function feedbackPayload(f: Feedback, time = new Date()): unknown {
  const fields = [
    ...(f.contact?.trim() ? [{ name: "Contact", value: clip(f.contact.trim(), 200), inline: false }] : []),
    ...Object.entries(f.context ?? {})
      .filter(([, v]) => v)
      .map(([k, v]) => ({ name: k, value: clip(scrub(v), 200), inline: true })),
  ];
  return {
    username: "cmd feedback",
    // People's text: no @everyone or role pings.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: TITLE[f.kind] ?? TITLE.other,
        description: clip(scrub(f.message.trim()), 4000),
        color: COLOR[f.kind] ?? COLOR.other,
        fields: fields.slice(0, 25),
        timestamp: time.toISOString(),
      },
    ],
  };
}
