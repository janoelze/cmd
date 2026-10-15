// Live topics of the widget API (docs/56: "`use()` is a subscription"): the core pushes, the
// widget never polls. A subscription listens to the services its topic is about only while it
// lives (no subscribe, no listener), reads the topic's value at once and again after each
// change (bursts coalesced), and sends it only when it differs from the last one sent: one
// message per change. Each topic is the live form of one read (protocol widget-verbs.ts's
// API_TOPIC names its verb); TOPICS below says what it listens to. `events` sends only the
// events that are new, within data/policy.ts. `storage` (1.3) is one key of one scope: a set
// in any window of the package (widgets/storage.ts's `changed`), or this window's state.

import { API_TOPIC, mergeEvents, topicVerb, type ApiEvent, type ApiEventQuery, type ApiTopic, type ApiVerb, type DataEvent, type WidgetPermissions, type WireValue } from "@cmd/protocol";
import type { CoreContext } from "../../kernel/context.ts";
import { matchesQuery } from "../../data/match.ts";
import { clampRows, clampQuery, type Reader } from "../../data/policy.ts";
import { checkoutOf } from "../../lib/checkout.ts";
import { WatchService } from "../../lib/watch.ts";
import { logger } from "@cmd/protocol/node";
import { ApiRefusal } from "./access.ts";
import { apiEvent } from "./model.ts";
import type { StorageChange, WidgetStorage } from "../storage.ts";

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
  /** The subscribing window, and its package's storage (the `storage` topic). */
  windowId?: string;
  storage?: { store: WidgetStorage; owner: string };
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
  // 1.2: a sample is a pane's update (panes.ts setUsage, only when it moved noticeably).
  terminalUsage: { listen: (core, _s, changed) => [on(core.panes, "updated", changed), on(core.panes, "removed", changed)] },
  // 1.3: a set of the key in any window of the package (the shared scopes), or this window's state (its own scope, and the workspace it is in).
  storage: {
    listen: (core, s, changed) => {
      const q = (s.query ?? {}) as { scope?: string; key?: string };
      const mine = s.storage ? (c: StorageChange) => c.owner === s.storage!.owner && c.scope === q.scope && c.key === q.key && (c.scope === "package" || c.id === s.own()) && changed() : null;
      const own = (w: { id: string }) => w.id === s.windowId && changed();
      return [on(core.windows, "updated", own), ...(mine && s.storage ? [on(s.storage.store, "changed", mine)] : [])];
    },
  },
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

/**
 * `events`: the query's result, then the new events that answer it, a burst at a time. With
 * `scope: "all"` (a `workspace: ["all"]` grant, checked by the first read) every workspace's,
 * each event clamped by data/policy.ts as its own workspace's.
 */
function subscribeEvents(core: TopicCore, s: TopicScope, push: (data: WireValue) => void): Off {
  const q = (s.query && typeof s.query === "object" ? s.query : {}) as ApiEventQuery;
  const first = s.read(API_TOPIC.events.verb, q) as ApiEvent[]; // checks the grant ("all" too), names what's missing
  const all = q.scope === "all";
  const reader: Reader = { kind: "widget", workspaceId: s.own(), declared: s.perms.events };
  const clamped = clampQuery(reader, { ...(Array.isArray(q.types) ? { types: q.types } : {}) }, { fallback: 200, max: 1000 });
  /** The workspace an event is read as, or null when this subscription doesn't see it. */
  const seenIn = (e: DataEvent) => (!e.workspaceId ? null : all ? (core.workspaces.get(e.workspaceId) ? e.workspaceId : null) : e.workspaceId === s.own() ? e.workspaceId : null);
  let pending: DataEvent[] = [];
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  const take = (events: DataEvent[]) => {
    if (closed) return;
    // An event recorded again within the burst (a command's start, then its end) goes once, as it is now.
    const fresh = events.filter((e) => {
      const w = seenIn(e);
      return !!w && matchesQuery({ ...clamped, workspaceId: w }, e);
    });
    pending = mergeEvents(pending, fresh, (e) => e.id);
    if (!pending.length || timer) return;
    timer = setTimeout(() => {
      timer = null;
      const seen = pending.flatMap((e) => clampRows({ ...reader, workspaceId: e.workspaceId }, clamped, [e]));
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
