// A session's conversation from its owned transcript (docs/28; summaries read
// this instead of the agent's file): prompts, answers and tool calls in order,
// from the inline message or the verbatim line in the blob.

import type { ConversationEntry } from "../../search/parser.ts";
import { describeToolInput } from "../../search/parser.ts";
import type { DataService } from "../service.ts";
import { textOf } from "../sources/transcripts.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** The entries of a session (`<agent>:<id>`), oldest first; empty when cmd has none of it. */
export function conversationOf(data: DataService, sessionKey: string): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  let after = 0;
  for (;;) {
    const page = data.store.query({ sessionId: sessionKey, types: ["transcript.message", "transcript.tool_use"], after, limit: 2000 });
    if (!page.length) break;
    for (const e of page) {
      const d = e.data as Obj;
      if (d.isSidechain || d.isMeta) continue;
      const at = e.at > 0 ? e.at : undefined;
      let message: Obj | null = isObj(d.message) ? d.message : null;
      if (!message && e.blob) {
        try {
          const line = JSON.parse(data.store.blob(e.blob)!.toString("utf8")) as Obj;
          message = isObj(line.message) ? line.message : isObj(line.payload) ? line.payload : null;
        } catch {}
      }
      if (e.type === "transcript.tool_use") {
        if (e.text) out.push({ role: "tool", text: e.text, at });
        continue;
      }
      const role = d.role === "assistant" ? "assistant" : "user";
      const content = message?.content ?? (isObj(d.payload) ? (d.payload.message ?? d.payload.content) : undefined);
      const text = textOf(content) || e.text || "";
      if (text) out.push({ role, text, at });
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!isObj(b) || (b.type !== "tool_use" && b.type !== "server_tool_use")) continue;
          const t = describeToolInput(b.input);
          if (t) out.push({ role: "tool", text: `${typeof b.name === "string" ? b.name : "tool"}: ${t}`, at });
        }
      }
    }
    after = page.at(-1)!.seq;
  }
  return out;
}
