// Who may read what of the event log (docs/28 §4, "Policy"): a table of client
// kind × class of data → allow | deny | declare | fields, and the query and rows
// a reader gets under it. Enforced here, on the query and on every row it
// returns, so a reader can't widen it by what it asks for. Widgets read their own
// workspace only; classes marked declare need the widget's manifest to name them
// (permissions.events); fields keeps only those payload keys, no blob, and no
// full-text search over the body, unless declared. Remote stays out of data.*
// altogether (remote/policy.ts).

import { DATA_CLASSES, classOf, type DataClass, type DataEvent, type DataQuery } from "@cmd/protocol";

/** allow: always; deny: never; declare: only when the reader declared the class; fields: these payload keys only, unless declared. */
export type Rule = "allow" | "deny" | "declare" | { fields: string[] };

export type ClientKind = "widget";

export const POLICY: Record<ClientKind, Record<DataClass, Rule>> = {
  widget: {
    git: "allow",
    notes: "allow",
    actions: "allow",
    // The command line, exit code and folder; what it printed (the blob, the body) only when declared.
    output: { fields: ["command", "exitCode", "cwd", "git", "output", "turn", "chars", "cut"] },
    agents: "declare", // prompts, tool calls, hook payloads
    transcripts: "declare", // whole conversations
    ai: "declare", // what cmd sent models and what came back
    browsing: "declare", // addresses and files
    system: "declare",
    remote: "deny", // the pairing audit log
  },
};

/** A reader of the log: what it is, the workspace it's confined to, the classes it declared. */
export interface Reader {
  kind: ClientKind;
  workspaceId: string | null;
  declared: readonly string[];
}

/** Classes a reader of this kind may declare (anything but deny). */
export const declarable = (kind: ClientKind): DataClass[] => (Object.keys(POLICY[kind]) as DataClass[]).filter((c) => POLICY[kind][c] !== "deny");

/** What a reader gets of one class: everything, the listed fields, or nothing. */
function access(r: Reader, c: DataClass): "all" | "fields" | "none" {
  const rule = POLICY[r.kind][c];
  if (rule === "deny") return "none";
  if (rule === "allow" || r.declared.includes(c)) return "all";
  return rule === "declare" ? "none" : "fields";
}

/** The classes a requested type reaches: a prefix may reach several ("agent.": agents and agent.output), a name one; an unknown one none (passed on: clampRows keeps its rows out unless their class is readable). */
function reached(t: string): DataClass[] {
  const prefix = t.endsWith(".");
  const hit = (Object.keys(DATA_CLASSES) as DataClass[]).filter((c) => DATA_CLASSES[c].types.some((p) => (prefix && p.startsWith(t)) || p === t || (p.endsWith(".") && t.startsWith(p))));
  return prefix || !hit.length ? hit : [classOf(t)];
}

export class PolicyError extends Error {}

const denied = (r: Reader, t: string, c: DataClass, why = "") =>
  new PolicyError(
    POLICY[r.kind][c] === "deny"
      ? `events: "${t}" is ${c} data, which widgets can't read`
      : `events: "${t}" ${why || `is ${c} data`}; to read it, add "${c}" to permissions.events in manifest.json`,
  );

/**
 * The query a reader may run for the one it asked: its workspace, whatever it
 * passed; types narrowed to the classes it may read (a type it named that it
 * can't read is an error that says how to declare it); the given limit. Throws
 * PolicyError.
 */
export function clampQuery(r: Reader, q: DataQuery, limit: { fallback: number; max: number }): DataQuery {
  if (!r.workspaceId) throw new PolicyError("events: this run has no workspace, so it can't read cmd's log");
  const classes = Object.keys(DATA_CLASSES) as DataClass[];
  const readable = (c: DataClass) => access(r, c) === "all" || (access(r, c) === "fields" && !q.text);
  let types: string[];
  if (q.types?.length) {
    types = [];
    for (const t of q.types) {
      if (typeof t !== "string" || !t) throw new PolicyError("events: types must be type names or prefixes ending in a dot");
      for (const c of reached(t)) {
        if (access(r, c) === "none") throw denied(r, t, c);
        if (!readable(c)) throw denied(r, t, c, `with text searches what commands printed`);
      }
      types.push(t);
    }
  } else types = classes.filter(readable).flatMap((c) => DATA_CLASSES[c].types);
  return { ...q, types, workspaceId: r.workspaceId, limit: Math.max(1, Math.min(Math.floor(Number(q.limit) || limit.fallback), limit.max)) };
}

/** The rows of a clamped query as the reader may see them: other workspaces and unreadable classes dropped, fields cut. */
export function clampRows(r: Reader, q: DataQuery, rows: DataEvent[]): DataEvent[] {
  const out: DataEvent[] = [];
  for (const e of rows) {
    if (e.workspaceId !== r.workspaceId) continue;
    const a = access(r, classOf(e.type));
    if (a === "none" || (a === "fields" && q.text)) continue; // a text match on the body says what it holds
    if (a === "all") {
      out.push(e);
      continue;
    }
    const rule = POLICY[r.kind][classOf(e.type)] as { fields: string[] };
    const data = Object.fromEntries(Object.entries(e.data ?? {}).filter(([k]) => rule.fields.includes(k)));
    out.push({ ...e, data: data as DataEvent["data"], blob: null });
  }
  return out;
}
