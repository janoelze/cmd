// Live topics of the widget API (docs/56: "`use()` is a subscription"): the core pushes, the
// widget never polls. A subscription listens to the services its topic is about only while it
// lives (no subscribe, no listener), reads the topic's value at once and again after each
// change (bursts coalesced), and sends it only when it differs from the last one sent: one
// message per change. Each topic is the live form of one read (protocol widget-verbs.ts's
// API_TOPIC names its verb); TOPICS below says what it listens to. `events` sends only the
// events that are new, within data/policy.ts.

import { API_TOPIC, topicVerb, type ApiEvent, type ApiEventQuery, type ApiTopic, type ApiVerb, type DataEvent, type WidgetPermissions, type WireValue } from "@cmd/protocol";
import type { CoreContext } from "../../kernel/context.ts";
import { matchesQuery } from "../../data/match.ts";
import { clampRows, clampQuery, type Reader } from "../../data/policy.ts";
import { checkoutOf } from "../../lib/checkout.ts";
import { WatchService } from "../../lib/watch.ts";
import { logger } from "@cmd/protocol/node";
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
  /** The adapter's read of a verb (adapter.ts), checking the grant as the verb does. */
  read(verb: ApiVerb, query: unknown): unknown;
}

type Off = () => void;
type Emitter = { on(e: string, fn: (...a: never[]) => void): unknown; off(e: string, fn: (...a: never[]) => void): unknown };
/** One listener per service and event, however many widgets subscribe (and none while nobody does). */
const hub = new WeakMap<object, Map<string, { fns: Set<(...a: never[]) => void>; real: (...a: never[]) => void }>>();
function on(em: Emitter, event: string, fn: (...a: never[]) => void): Off {
  let byEvent = hub.get(em);
  if (!byEvent) hub.set(em, (byEvent = new Map()));
  let h = byEvent.get(event);
  if (!h) {
    const fns = new Set<(...a: never[]) => void>();
    const real = (...a: never[]) => {
      for (const f of [...fns]) f(...a);
    };
    byEvent.set(event, (h = { fns, real }));
    em.on(event, real);
  }
  h.fns.add(fn);
  return () => {
    const cur = byEvent.get(event);
    if (!cur || !cur.fns.delete(fn) || cur.fns.size) return;
    em.off(event, cur.real);
    byEvent.delete(event);
  };
}

/** What a topic listens to, calling `changed` on each change; what it returns stops it. */
type Listen = (core: TopicCore, s: TopicScope, changed: () => void) => Off[];

/** Each topic but events (subscribeEvents): what it listens to while subscribed, and how long a burst is gathered. */
const TOPICS: { [T in Exclude<ApiTopic, "events">]: { listen: Listen; coalesceMs?: number } } = {
  workspace: { listen: (core, _s, changed) => [on(core.workspaces, "updated", changed)] },
  agents: { listen: (core, _s, changed) => [on(core.agents, "updated", changed), on(core.agents, "removed", changed)] },
  terminals: { listen: (core, _s, changed) => [on(core.panes, "updated", changed), on(core.panes, "removed", changed)] },
  windows: {
    listen: (core, _s, changed) => [on(core.windows, "updated", changed), on(core.windows, "removed", changed), on(core.panes, "updated", changed), on(core.panes, "removed", changed), on(core.workspaces, "updated", changed)],
  },
  actions: { listen: (core, _s, changed) => [on(core.actions, "changed", changed)] },
  git: {
    coalesceMs: GIT_COALESCE_MS,
    // Staging, committing, switching: the repository's index and HEAD.
    listen: (_core, s, changed) => {
      const dir = s.root() ? checkoutOf(s.root()!)?.gitDir : null;
      if (!dir) return [];
      const w = new WatchService();
      w.on("changed", changed);
      w.watch(`${dir}/index`);
      w.watch(`${dir}/HEAD`);
      return [() => w.close()];
    },
  },
};

/** Subscribe; throws ApiRefusal when the grant doesn't reach the topic (checked by its first read). */
export function subscribeTopic(core: TopicCore, s: TopicScope, push: (data: WireValue) => void): Off {
  const verb = topicVerb(s.topic);
  if (!verb) throw new ApiRefusal({ code: "unknown", message: `This cmd has no live ${String(s.topic).slice(0, 40)}.` });
  if (s.topic === "events") return subscribeEvents(core, s, push);
  const topic = TOPICS[s.topic];
  const q = s.query && typeof s.query === "object" ? s.query : {};
  const read = (): unknown => s.read(verb, q);
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
      topic.coalesceMs ?? TOPIC_COALESCE_MS,
    );
    timer.unref?.();
  };
  const offs = topic.listen(core, s, changed);
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
  const first = s.read(API_TOPIC.events.verb, q) as ApiEvent[]; // checks the grant, names what's missing
  const reader: Reader = { kind: "widget", workspaceId: s.own(), declared: s.perms.events };
  const clamped = clampQuery(reader, { ...(Array.isArray(q.types) ? { types: q.types } : {}) }, { fallback: 200, max: 1000 });
  let pending: DataEvent[] = [];
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const take = (events: DataEvent[]) => {
    if (closed) return;
    // An event recorded again within the burst (a command's start, then its end) goes once, as it is now.
    for (const e of events) if (e.workspaceId === s.own() && matchesQuery({ ...clamped, workspaceId: s.own() }, e)) pending = [...pending.filter((x) => x.id !== e.id), e];
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
