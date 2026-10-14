// @cmd/widget-api/testing against the example widget (examples/v1/agents.tsx): docs/56's
// own test, then the fake host's reads, acts, pushes and the matchers.

import { describe, expect, it, test } from "vitest";
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import { Stat, Inline, useData, useCompletion, cmd, defineWidget, View, Text, ApiCallError } from "@cmd/widget-api";
import Widget from "../examples/v1/agents.tsx";

test("waiting agents come first", async () => {
  const host = createHost({ agents: [fixtures.agent({ name: "Tours", state: "waiting" }), fixtures.agent({ name: "Perf", state: "working" })] });
  const tree = await render(<Widget />, host);
  expect(tree).toHaveSection("Waiting for you", { count: 1 });
  expect(tree.rows()[0]).toHaveTitle("Tours");
  await tree.press(tree.rows()[0]!);
  expect(host.calls).toEqual([["windows.select", "w-tours"]]);
});

describe("the example widget", () => {
  it("shows the empty state with no agents", async () => {
    const tree = await render(<Widget />, createHost());
    expect(tree).toShowState("empty", "No agents");
    expect(tree.rows()).toHaveLength(0);
  });

  it("follows the agents live: a push re-renders it as a patch", async () => {
    const host = createHost({ agents: [fixtures.agent({ name: "Perf", state: "working" })] });
    const tree = await render(<Widget />, host);
    expect(tree).not.toHaveSection("Waiting for you");
    const patches = tree.mirror.patches;
    host.set({ agents: [fixtures.agent({ name: "Perf", state: "waiting" })] });
    await tree.idle();
    expect(tree).toHaveSection("Waiting for you", { count: 1 });
    expect(tree.mirror.trees).toBe(1);
    expect(tree.mirror.patches).toBeGreaterThan(patches);
  });

  it("switches scope from the title menu and keeps it in the window's state", async () => {
    const host = createHost({ agents: [fixtures.agent({ name: "Here" }), fixtures.agent({ name: "Elsewhere", workspaceId: "ws-2" })] });
    const tree = await render(<Widget />, host);
    expect(tree).toHaveRow("Here");
    expect(tree).not.toHaveRow("Elsewhere");
    await tree.choose(tree.find("Window"), "All Workspaces");
    expect(tree).toHaveRow("Elsewhere");
    expect(host.requests).toContainEqual(["state.set", "scope", "all"]);
    expect(host.subscriptions()).toEqual([{ id: expect.any(Number), topic: "agents", query: { scope: "all" } }]);
  });

  it("starts with the stored scope", async () => {
    const host = createHost({ state: { scope: "all" }, agents: [fixtures.agent({ name: "Elsewhere", workspaceId: "ws-2" })] });
    const tree = await render(<Widget />, host);
    expect(tree).toHaveRow("Elsewhere");
  });

  it("says who waits in the title bar", async () => {
    const host = createHost({ agents: [fixtures.agent({ name: "A", state: "waiting" }), fixtures.agent({ name: "B" }), fixtures.agent({ name: "C" })] });
    const tree = await render(<Widget />, host);
    expect(tree.find("Window").props.status).toBe("1 waiting for you · 2 working");
  });
});

describe("the fake host", () => {
  it("serves reads and records only acts", async () => {
    let seen: unknown[] = [];
    function Reads() {
      const { data } = useData(async () => {
        const ws = await cmd.workspace.get();
        const screen = await cmd.terminals.read("t-build", { lines: 1 });
        const stats = await cmd.events.stats({ types: ["command"] });
        await cmd.notify.send({ key: "k", title: "Done" });
        return [ws.name, screen.text, screen.untrusted, stats.total];
      });
      seen = data ?? [];
      return <Text>{String(data?.[0] ?? "")}</Text>;
    }
    const host = createHost({ terminals: [fixtures.pane({ title: "build", screen: "one\ntwo" })], events: [fixtures.event(), fixtures.event({ type: "agent.stop" })] });
    const tree = await render(<Reads />, host);
    expect(seen).toEqual(["app", "two", true, 1]);
    expect(tree.text()).toBe("app");
    expect(host.calls).toEqual([["notify.send", { key: "k", title: "Done" }]]);
  });

  it("refuses a verb the grant lacks, naming the permission, and the widget runs on", async () => {
    let error: unknown = null;
    function Denied() {
      const { data, error: e } = useData(() => cmd.agents.list());
      error = e;
      return <Text>{data ? "data" : "none"}</Text>;
    }
    const tree = await render(<Denied />, createHost({ deny: { "agents.list": "workspace:read" } }));
    expect(error).toBeInstanceOf(ApiCallError);
    expect((error as ApiCallError).permission).toBe("workspace:read");
    expect(tree.text()).toBe("none");
  });

  it("pushes events as they happen", async () => {
    function Log() {
      const events = cmd.events.use({ types: ["command"] });
      return <Stat label="Commands" value={events.length} />;
    }
    const host = createHost({ events: [fixtures.event()] });
    const tree = await render(<Log />, host);
    expect(tree).toHaveStat("Commands", 1);
    host.emit(fixtures.event(), fixtures.event({ type: "browser.open" }));
    await tree.idle();
    expect(tree).toHaveStat("Commands", 2);
  });

  it("gives defineWidget the config, live", async () => {
    const W = defineWidget<{ repo: string }>(({ config }) => (
      <View>
        <Inline>
          <Text>{config.repo}</Text>
        </Inline>
      </View>
    ));
    const host = createHost({ config: { repo: "jan/cmd" } });
    const tree = await render(W, host);
    expect(tree.text()).toBe("jan/cmd");
    host.set({ config: { repo: "jan/other" } });
    await tree.idle();
    expect(tree.text()).toBe("jan/other");
  });

  it("fetches through the host, from fixtures, with auth named and never a secret", async () => {
    const url = "https://api.github.com/repos/jan/cmd/actions/runs";
    function Runs() {
      const { data, error } = useData(async () => JSON.parse((await cmd.net.fetch(url, { auth: "token" })).body) as { total_count: number });
      return <Stat label="Runs" value={error ? "error" : (data?.total_count ?? "–")} />;
    }
    const host = createHost({ fetch: { [url]: { body: { total_count: 7 } } } });
    const tree = await render(<Runs />, host);
    expect(tree).toHaveStat("Runs", 7);
    expect(host.calls).toEqual([["net.fetch", url, { auth: "token" }]]);
  });

  it("serves fetches from a function, and fails one without a fixture, naming it", async () => {
    const seen: string[] = [];
    function Two() {
      const a = useData(() => cmd.net.fetch("https://a.example/x"));
      const b = useData(() => cmd.net.fetch("https://b.example/y"));
      seen.push(String(a.data?.status), b.error?.message ?? "");
      return null;
    }
    await render(<Two />, createHost({ fetch: (u) => (u.startsWith("https://a.") ? { status: 201 } : Promise.resolve(undefined as never)) }));
    expect(seen.at(-2)).toBe("201");
    expect(seen.at(-1)).toContain("No fetch fixture for GET https://b.example/y");
  });

  it("names the permission to add when the grant lacks it", async () => {
    let error: ApiCallError | null = null;
    function NoNet() {
      const { error: e } = useData(() => cmd.net.fetch("https://api.github.com/"));
      error = e as ApiCallError | null;
      return null;
    }
    await render(<NoNet />, createHost({ deny: { "net.fetch": 'net: ["api.github.com"]' } }));
    expect(error).toMatchObject({ code: "permission", permission: 'net: ["api.github.com"]' });
  });

  it("completes with the AI from fixtures: useCompletion asks once per request", async () => {
    function Summary({ prompt }: { prompt: string }) {
      const { data, loading } = useCompletion({ prompt, maxTokens: 50 });
      return <Text>{loading ? "…" : data && "text" in data ? data.text : ""}</Text>;
    }
    const host = createHost({ ai: (req) => ({ text: `about ${req.prompt}`, usage: { input: 3, output: 2 } }) });
    const tree = await render(<Summary prompt="CI" />, host);
    expect(tree.text()).toBe("about CI");
    expect(host.calls).toEqual([["ai.complete", { prompt: "CI", maxTokens: 50 }]]);
    const answer = await cmd.ai.complete({ prompt: "x", schema: { type: "object" } });
    expect(answer).toEqual({ text: "about x", usage: { input: 3, output: 2 } });
  });

  it("refuses the AI without its grant, naming it", async () => {
    let error: unknown = null;
    function Ask() {
      error = useCompletion({ prompt: "hi" }).error;
      return null;
    }
    await render(<Ask />, createHost({ ai: { text: "hello" }, deny: { "ai.complete": 'ai: ["complete"]' } }));
    expect(error).toMatchObject({ code: "permission", permission: 'ai: ["complete"]' });
  });

  it("snapshots without ids", async () => {
    const tree = await render(<Stat label="Runs" value={3} onSelect={() => {}} />);
    expect(tree.toJSON()).toEqual([{ type: "Stat", props: { label: "Runs", value: 3, onSelect: "ƒ" }, children: [] }]);
  });
});
