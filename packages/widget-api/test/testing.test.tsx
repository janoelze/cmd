// @cmd/widget-api/testing against the example widget (examples/v1/agents.tsx): docs/56's
// own test, then the fake host's reads, acts, pushes and the matchers.

import { describe, expect, it, test } from "vitest";
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import { Stat, Inline, useData, cmd, defineWidget, View, Text, EmptyState, ApiCallError } from "@cmd/widget-api";
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

  it("keeps secrets out of the tree", async () => {
    function Leaky() {
      const { data } = useData(() => cmd.secrets.get("token"));
      return <EmptyState title={`token ${data ?? ""}`} />;
    }
    const tree = await render(<Leaky />, createHost({ secrets: { token: "s3cr3t-value" } }));
    expect(tree.text()).toBe("token ••••");
  });

  it("snapshots without ids", async () => {
    const tree = await render(<Stat label="Runs" value={3} onSelect={() => {}} />);
    expect(tree.toJSON()).toEqual([{ type: "Stat", props: { label: "Runs", value: 3, onSelect: "ƒ" }, children: [] }]);
  });
});
