// Reading back what another cmd version saved. Stored documents (SQLite rows,
// JSON files) are never cast to their type: each is decoded against its type's
// defaults, so a field a newer format added is filled in and a field of the
// wrong kind is replaced. A row that can't be read at all (not JSON, no id) is
// skipped with a warning: losing one record beats a core that can't start.
// Fields the defaults don't know (written by a newer cmd) are kept as they are.

import type { Agent, AgentHome, AgentTurn, AppWindow, Space, TurnFile } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import type { PaneRecord } from "./panes.ts";
import type { TranscriptRoot } from "./search/sources.ts";
import type { RemoteDeviceRecord } from "./store.ts";

const log = logger("stored");

/**
 * Every required field with what to use when it's missing or of another kind
 * (null: any value is fine, missing becomes null). Optional fields may be left
 * out: they are kept as they are.
 */
export type Defaults<T> = { [K in keyof T]: Exclude<T[K], undefined> | null };

type Kind = "array" | "object" | "string" | "number" | "boolean" | "null" | "other";
const kindOf = (v: unknown): Kind =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? (typeof v as Kind) : "other";

/**
 * A decoder for one type: `required` fields must be there with the default's kind
 * (else the document is rejected), the rest fall back to their default. `fix`
 * repairs nested values.
 */
export function decoder<T extends object>(defaults: Defaults<T>, required: (keyof T & string)[] = [], fix?: (t: T) => void): (raw: unknown) => T | null {
  return (raw) => {
    if (kindOf(raw) !== "object") return null;
    const src = raw as Record<string, unknown>;
    const out: Record<string, unknown> = { ...src };
    for (const [k, d] of Object.entries(defaults)) {
      const v = src[k];
      const ok = v !== undefined && (d === null || kindOf(v) === kindOf(d));
      if (ok) continue;
      if (required.includes(k as keyof T & string)) return null;
      out[k] = structuredClone(d);
    }
    fix?.(out as T);
    return out as T;
  };
}

/** One document from its JSON; null (and a warning) when it can't be read. */
export function decodeDoc<T>(what: string, json: string, decode: (raw: unknown) => T | null): T | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    log.warn(`stored ${what} skipped: not JSON (${(err as Error).message})`);
    return null;
  }
  try {
    const t = decode(raw);
    if (t === null) log.warn(`stored ${what} skipped: unreadable`, { doc: json.slice(0, 300) });
    return t;
  } catch (err) {
    log.warn(`stored ${what} skipped: ${(err as Error).message}`, { doc: json.slice(0, 300) });
    return null;
  }
}

/** Every row that can be read, in order. */
export function decodeRows<T>(what: string, docs: string[], decode: (raw: unknown) => T | null): T[] {
  const out: T[] = [];
  for (const doc of docs) {
    const t = decodeDoc(what, doc, decode);
    if (t !== null) out.push(t);
  }
  return out;
}

// ── the stored types ────────────────────────────────────

const decodeFile = decoder<TurnFile>({ path: "", change: "M", via: [] }, ["path"]);

export const decodeTurn = decoder<AgentTurn>(

  {
    format: 1,
    derivedBy: null,
    agentId: "",
    agentKind: "claude",
    agentVersion: null,
    model: null,
    index: 0,
    sessionId: null,
    turnId: null,
    startedAt: 0,
    endedAt: null,
    prompt: null,
    auto: false,
    followUps: [],
    notes: [],
    background: [],
    outcome: "done",
    ask: null,
    final: null,
    error: null,
    tools: [],
    commands: [],
    shellWrites: 0,
    files: [],
    subagents: 0,
    events: 0,
    inferred: [],
  },
  ["agentId", "index"],
  (t) => {
    t.files = t.files.map(decodeFile).filter((f): f is TurnFile => f !== null);
    t.tools = t.tools.filter((x) => kindOf(x) === "object" && typeof x.name === "string").map((x) => ({ name: x.name, count: Number(x.count) || 0, failed: Number(x.failed) || 0 }));
    for (const k of ["followUps", "notes", "background", "commands", "inferred"] as const) t[k] = t[k].filter((x) => typeof x === "string");
  },
);

export const decodeAgent = decoder<Agent>(

  {
    id: "",
    paneId: null,
    spaceId: "",
    kind: "claude",
    name: null,
    cwd: "",
    parentId: null,
    rootId: "",
    depth: 0,
    spawn: { source: "detected" },
    native: {},
    state: "idle",
    stateSince: 0,
    detail: null,
    lastMessage: null,
    lastPrompt: null,
    seenAt: null,
    createdAt: 0,
    turn: null,
    stateCause: null,
    version: null,
    model: null,
  },
  ["id", "kind"],
  (a) => {
    if (!a.rootId) a.rootId = a.id;
    if (a.turn) a.turn = decodeTurn(a.turn);
  },
);

export const decodePane = decoder<PaneRecord>(

  {
    id: "",
    spaceId: "",
    title: "",
    cwd: "",
    shell: "",
    cols: 80,
    rows: 24,
    createdAt: 0,
    muted: false,
    attention: null,
    command: null,
    token: "",
    host: "",
  },
  ["id"],
);

export const decodeSpace = decoder<Space>(
  { id: "", name: "", root: "", home: false, icon: null, order: 0, closedAt: null, createdAt: 0, lastActiveAt: 0, view: {} },
  ["id", "root"],
);

export const decodeWindow = decoder<AppWindow>({ id: "", spaceId: "", kind: "", title: "", createdAt: 0, updatedAt: 0, state: {} }, ["id", "kind"]);

export const decodeHome = decoder<AgentHome>({ agent: "claude", dir: "", via: [], env: null, firstSeen: 0, lastSeen: 0 }, ["agent", "dir"]);

export const decodeRoot = decoder<TranscriptRoot>({ agent: null, dir: "", env: null }, ["dir"]);

export const decodeRemoteDevice = decoder<RemoteDeviceRecord>({ id: "", name: "", scope: null, publicKey: "", pairedAt: 0, lastSeenAt: 0 }, ["id", "publicKey", "scope"]);
