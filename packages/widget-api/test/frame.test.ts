// @cmd/widget-api/frame against the protocol's API: a frame's page has every verb of API_VERBS
// under the name the process's `cmd` gives it, with the same signature, and a `subscribe` on
// each live topic's namespace taking that topic's read's query and value. The page's runtime
// (apps/desktop/src/package-frame/frame.js) is checked against the same registry by the
// desktop's package-frames.test.ts.

import { describe, expectTypeOf, it } from "vitest";
import type { ApiEvent, ApiMethods, ApiTopic, ApiVerb, ApiAgent } from "@cmd/protocol/widget-tree";
import type { FrameCmd, FrameNamespaces, TopicValue } from "@cmd/widget-api/frame";

/** `cmd.agents.list` for "agents.list" (`cmd.run.exec` for "run.exec"). */
type FrameVerb<V extends string> = V extends `${infer N extends keyof FrameCmd}.${infer M}` ? (M extends keyof FrameCmd[N] ? FrameCmd[N][M] : never) : never;
type Signature<V extends ApiVerb> = (...args: ApiMethods[V]["params"]) => Promise<ApiMethods[V]["result"]>;
/** state.get answers at once in a page (it has the window's state), so `await` works on it as on the process's. */
type EveryVerb = { [V in Exclude<ApiVerb, "state.get">]: FrameVerb<V> extends Signature<V> ? true : V };
type NsOf<V> = V extends `${infer N}.${string}` ? N : never;
type EveryTopic = { [T in ApiTopic]: FrameCmd[T] extends { subscribe(fn: (v: TopicValue<T>) => void): () => void } ? true : T };

describe("a frame's cmd", () => {
  it("has every verb of the API under the process's name and signature", () => {
    expectTypeOf<EveryVerb[Exclude<ApiVerb, "state.get">]>().toEqualTypeOf<true>();
    expectTypeOf<ReturnType<FrameCmd["state"]["get"]>>().toEqualTypeOf<Awaited<ReturnType<Signature<"state.get">>> | null>();
    // No namespace more or fewer than the API's (fmt, config and env are the page's own).
    expectTypeOf<keyof FrameNamespaces | "run" | "state">().toEqualTypeOf<NsOf<ApiVerb>>();
  });

  it("subscribes to every live topic with its read's value", () => {
    expectTypeOf<EveryTopic[ApiTopic]>().toEqualTypeOf<true>();
    expectTypeOf<TopicValue<"agents">>().toEqualTypeOf<ApiAgent[]>();
    expectTypeOf<TopicValue<"events">>().toEqualTypeOf<ApiEvent[]>();
    const typed = (c: FrameCmd) => [c.on("agents", (a) => expectTypeOf(a).toEqualTypeOf<ApiAgent[]>(), { scope: "all" }), c.agents.subscribe({ scope: "all" }, (a) => expectTypeOf(a).toEqualTypeOf<ApiAgent[]>())];
    void typed;
  });
});
