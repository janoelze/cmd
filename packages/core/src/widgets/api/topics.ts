// Live topics of the widget API (docs/56: "`use()` is a subscription"): the core pushes, the
// widget never polls. A subscription listens to the services its topic is about only while it
// lives (no subscribe, no listener), reads the topic's value at once and again after each
// change (bursts coalesced), and sends it only when it differs from the last one sent: one
// message per change. `events` sends only the events that are new, within data/policy.ts.

import type { ApiEvent, ApiTopic, DataEvent, WidgetPermissions, WireValue } from "@cmd/protocol";
import type { CoreContext } from "../../kernel/context.ts";
import { matchesQuery } from "../../data/match.ts";
import { clampRows, clampQuery, type Reader } from "../../data/policy.ts";
import { checkoutOf } from "../../lib/checkout.ts";
import { WatchService } from "../../lib/watch.ts";
import { logger } from "@cmd/protocol/node";
import { API_TOPICS, type ApiEventQuery } from "@cmd/protocol";
import { ApiRefusal, invalid } from "./access.ts";
import { apiEvent } from "./model.ts";

const log = logger("widgets");

/** How long a burst of changes is gathered before the topic is read again (ms). */
export const TOPIC_COALESCE_MS = 50;
/** Git runs a process: its topic waits a little longer. */
const GIT_COALESCE_MS = 400;

type TopicCore = Pick<CoreContext, "agents" | "panes" | "windows" | "workspaces" | "data" | "actions">;

export interface TopicScope {
  topic: ApiTopic;
  query: unknown;
  own: () => string;
  perms: WidgetPermissions;
  root: () => string | null;
  /** The adapter's reads (v1.ts), each checking the grant as its verb does. */
  reads: {
    agents(q: unknown): unknown;
    terminals(q: unknown): unknown;
    windows(q: unknown): unknown;
    events(q: ApiEventQuery): ApiEvent[];
    git(): Promise<unknown>;
    actions(): unknown;
    workspace(): unknown;
  };
}

type Off = () => void;
function on<E extends { on(e: string, fn: (...a: never[]) => void): unknown; off(e: string, fn: (...a: never[]) => void): unknown }>(em: E, event: string, fn: (...a: never[]) => void): Off {
  em.on(event, fn);
  return () => void em.off(event, fn);
}

/** Subscribe; throws ApiRefusal when the grant doesn't reach the topic (checked by its first read). */
export function subscribeTopic(core: TopicCore, s: TopicScope, push: (data: WireValue) => void): Off {
  if (!(API_TOPICS as readonly string[]).includes(s.topic)) throw new ApiRefusal({ code: "unknown", message: `This cmd has no live ${String(s.topic).slice(0, 40)}.` });
  if (s.topic === "events") return subscribeEvents(core, s, push);
  const q = s.query && typeof s.query === "object" ? s.query : {};
  const read = (): unknown => {
    switch (s.topic) {
      case "agents":
        return s.reads.agents(q);
      case "terminals":
        return s.reads.terminals(q);
      case "windows":
        return s.reads.windows(q);
      case "actions":
        return s.reads.actions();
      case "workspace":
        return s.reads.workspace();
      default:
        return s.reads.git();
    }
  };
  // The first read checks the grant: a refusal throws before anything listens.
  const first = read();
  let last = "";
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  const send = (v: unknown) => {
    const text = JSON.stringify(v ?? null);
    if (closed || text === last) return;
    last = text;
    push((v ?? null) as WireValue);
  };
  const settle = (v: unknown) => (v instanceof Promise ? v.then(send, (e) => log.debug(`a widget's ${s.topic} read failed: ${(e as Error).message}`)) : send(v));
  const changed = () => {
    if (timer || closed) return;
    timer = setTimeout(
      () => {
        timer = null;
        try {
          void settle(read());
        } catch {}
      },
      s.topic === "git" ? GIT_COALESCE_MS : TOPIC_COALESCE_MS,
    );
    timer.unref?.();
  };
  const offs: Off[] = [];
  switch (s.topic) {
    case "agents":
      offs.push(on(core.agents, "updated", changed), on(core.agents, "removed", changed));
      break;
    case "terminals":
      offs.push(on(core.panes, "updated", changed), on(core.panes, "removed", changed));
      break;
    case "windows":
      offs.push(on(core.windows, "updated", changed), on(core.windows, "removed", changed), on(core.panes, "updated", changed), on(core.panes, "removed", changed), on(core.workspaces, "updated", changed));
      break;
    case "workspace":
      offs.push(on(core.workspaces, "updated", changed));
      break;
    case "actions":
      offs.push(on(core.actions, "changed", changed));
      break;
    case "git": {
      // Staging, committing, switching: the repository's index and HEAD.
      const dir = s.root() ? checkoutOf(s.root()!)?.gitDir : null;
      if (dir) {
        const w = new WatchService();
        w.on("changed", changed);
        w.watch(`${dir}/index`);
        w.watch(`${dir}/HEAD`);
        offs.push(() => w.close());
      }
      break;
    }
  }
  void settle(first);
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    for (const off of offs) off();
  };
}

/** `events`: the query's result, then the new events that answer it, a burst at a time. */
function subscribeEvents(core: TopicCore, s: TopicScope, push: (data: WireValue) => void): Off {
  const q = (s.query && typeof s.query === "object" ? s.query : {}) as ApiEventQuery;
  if (q.scope === "all") throw invalid("A live events query reads this workspace; use events.query with scope \"all\" for every workspace.");
  const first = s.reads.events(q); // checks the grant, names what's missing
  const reader: Reader = { kind: "widget", workspaceId: s.own(), declared: s.perms.events };
  const clamped = clampQuery(reader, { ...(Array.isArray(q.types) ? { types: q.types } : {}) }, { fallback: 200, max: 1000 });
  let pending: DataEvent[] = [];
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const take = (events: DataEvent[]) => {
    if (closed) return;
    for (const e of events) if (e.workspaceId === s.own() && matchesQuery({ ...clamped, workspaceId: s.own() }, e)) pending.push(e);
    if (!pending.length || timer) return;
    timer = setTimeout(() => {
      timer = null;
      const seen = clampRows({ ...reader, workspaceId: s.own() }, clamped, pending);
      pending = [];
      if (seen.length && !closed) push(seen.map(apiEvent) as unknown as WireValue);
    }, TOPIC_COALESCE_MS);
    timer.unref?.();
  };
  const onOne = (e: DataEvent) => take([e]);
  const offs = [on(core.data, "recorded", onOne), on(core.data, "batch", take)];
  push(first as unknown as WireValue);
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    for (const off of offs) off();
  };
}
