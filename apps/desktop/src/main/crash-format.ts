// What a crash report looks like on its way out (main/crash.ts): the Discord
// message, home folders scrubbed, and the signature that recognises a repeat.

import { createHash } from "node:crypto";
import os from "node:os";
import type { CrashReport } from "@cmd/protocol/node";

/** Same process, kind, message (numbers and paths aside) and top frame: the same crash. */
export function signature(r: Pick<CrashReport, "process" | "kind" | "message" | "stack">): string {
  const norm = (s: string) => s.replace(/(\/|[A-Z]:\\)[^\s:'"()]+/g, "<path>").replace(/0x[0-9a-f]+|\b\d+\b/gi, "N");
  const frame = r.stack?.split("\n").find((l) => l.trim().startsWith("at ")) ?? "";
  return createHash("sha1").update([r.process, r.kind, norm(r.message), norm(frame)].join("\n")).digest("hex");
}

/** Home folders become ~ (the user name is in the path). */
export function scrub(s: string): string {
  const home = os.homedir();
  let out = home ? s.split(home).join("~") : s;
  out = out.replace(/\/(Users|home)\/[^/\s"'\\]+/g, "~").replace(/[A-Z]:\\\\?Users\\\\?[^\\\s"']+/gi, "~");
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function payload(r: CrashReport, repeats: number): unknown {
  const c = r.context;
  const fields = [
    { name: "Version", value: `${c.version ?? "?"} (${c.channel ?? "?"})`, inline: true },
    { name: "Process", value: `${r.process} · ${r.kind}`, inline: true },
    { name: "Platform", value: c.platform ?? "?", inline: true },
    ...Object.entries(c)
      .filter(([k, v]) => !["version", "channel", "platform"].includes(k) && v)
      .map(([k, v]) => ({ name: k, value: clip(scrub(v), 200), inline: true })),
  ];
  if (repeats > 1) fields.push({ name: "Repeats", value: `${repeats} more since the last report`, inline: true });
  const stack = r.stack ? scrub(r.stack) : r.log.length ? scrub(r.log.slice(-15).join("\n")) : "";
  return {
    username: "cmd crashes",
    embeds: [
      {
        title: clip(scrub(`${r.process}: ${r.message}`), 250),
        description: stack ? `\`\`\`\n${clip(stack.replace(/```/g, "'''"), 3800)}\n\`\`\`` : undefined,
        color: c.channel === "dev" ? 0xf5a524 : 0xe5484d,
        fields: fields.slice(0, 25),
        footer: { text: r.id },
        timestamp: r.time,
      },
    ],
  };
}
